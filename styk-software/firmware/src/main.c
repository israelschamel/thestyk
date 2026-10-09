/*
 * Styk tag firmware 0.2.0
 *
 * Target: nRF52832 (nRF52 DK for prototyping).
 * Builds with Zephyr 3.7 LTS and nRF Connect SDK 2.7 to 2.9; see README.md.
 * The Bluetooth protocol shared with the Styk app is documented in ../PROTOCOL.md.
 *
 * What it does
 *  - Pairing mode (no owner yet): advertises as "Styk-XXXX" so the app can find it.
 *    Pairing needs the 6-digit PIN printed with the tag's code, so only the person
 *    holding the sticker can claim it. One owner at a time.
 *  - Owned mode: advertises as plain "Styk" with a rotating encrypted ID, so nobody
 *    can follow it by a fixed name or number.
 *  - The owner's app can play a sound, read battery and status, set the clock,
 *    and release ownership.
 *  - Separation: 30 minutes without the owner the tag switches to "separated" mode
 *    (ID rotates every 24 h instead of every 15 min, as the IETF unwanted-tracker
 *    draft describes). After STYK_ALERT_AFTER_HOURS without the owner it chirps,
 *    so a tag travelling with someone else can be found.
 *  - Advertising slows to 10.24 s when the battery is low.
 */
#include <zephyr/kernel.h>
#include <zephyr/version.h>
#include <zephyr/sys/printk.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/sys/crc.h>
#include <zephyr/sys/util.h>
#include <zephyr/drivers/pwm.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/hwinfo.h>
#include <zephyr/settings/settings.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/bluetooth/crypto.h>
#include <zephyr/bluetooth/services/bas.h>
#include <string.h>

#define FW_MAJOR 0
#define FW_MINOR 2
#define FW_PATCH 0

/* ---------------- timing ---------------- */
#define HOUSEKEEPING_S       60
#define NEAR_OWNER_ROTATE_S  (15 * 60)            /* ID rotation while near the owner */
#define SEPARATED_ROTATE_S   (24 * 60 * 60)       /* ID rotation once separated */
#define SEPARATED_AFTER_MS   (30LL * 60 * 1000)   /* away from the owner this long = separated */
#ifndef STYK_ALERT_AFTER_HOURS
#define STYK_ALERT_AFTER_HOURS 8                  /* chirp after this long without the owner */
#endif
#define ALERT_AFTER_MS       ((int64_t)STYK_ALERT_AFTER_HOURS * 3600 * 1000)
#define CHARGE_RISE_MV       20                   /* battery rise per minute that counts as charging */
#define LOW_BATTERY_PCT      15

#if defined(CONFIG_BOARD_NRF52DK) || defined(CONFIG_BOARD_NRF52DK_NRF52832)
#define STYK_DEV_KIT 1
#endif

/* Battery range used for the percentage. */
#ifdef STYK_DEV_KIT
#define BATT_EMPTY_MV 2000   /* development kit: coin cell or USB supply */
#define BATT_FULL_MV  3000
#else
#define BATT_EMPTY_MV 3000   /* Styk board: lithium polymer cell */
#define BATT_FULL_MV  4200
#endif

/* Advertising intervals in units of 0.625 ms. */
#define ADV_PAIRING_MIN 0x0320   /* 500 ms while waiting to be claimed */
#define ADV_PAIRING_MAX 0x0360
#define ADV_NORMAL_MIN  0x0C80   /* 2.0 s */
#define ADV_NORMAL_MAX  0x0DC0   /* 2.2 s */
#define ADV_SLOW        0x4000   /* 10.24 s, the longest Bluetooth allows */

#if KERNEL_VERSION_MAJOR >= 4
#define ADV_OPTS BT_LE_ADV_OPT_CONN
#else
#define ADV_OPTS (BT_LE_ADV_OPT_CONNECTABLE | BT_LE_ADV_OPT_ONE_TIME)
#endif

#define COMPANY_ID_TEST 0xFFFF   /* TODO: replace with an assigned Bluetooth SIG company ID */

/* ---------------- UUIDs: 5a7e000N-6b1d-4c3a-9f2e-0a1b2c3d4e5f ---------------- */
#define STYK_UUID(n) BT_UUID_128_ENCODE(0x5a7e0000 + (n), 0x6b1d, 0x4c3a, 0x9f2e, 0x0a1b2c3d4e5f)
static const struct bt_uuid_128 svc_uuid = BT_UUID_INIT_128(STYK_UUID(1));
static const struct bt_uuid_128 alert_uuid = BT_UUID_INIT_128(STYK_UUID(2));
static const struct bt_uuid_128 control_uuid = BT_UUID_INIT_128(STYK_UUID(3));
static const struct bt_uuid_128 status_uuid = BT_UUID_INIT_128(STYK_UUID(4));
static const struct bt_uuid_128 info_uuid = BT_UUID_INIT_128(STYK_UUID(5));
static const uint8_t svc_uuid_bytes[16] = { STYK_UUID(1) };

/* Alert values */
#define ALERT_STOP  0x00
#define ALERT_FIND  0x01
#define ALERT_CHIRP 0x02
/* Control commands */
#define CMD_RELEASE  0x10
#define CMD_SET_TIME 0x30

/* ---------------- status shared with the app (little endian) ---------------- */
struct __packed styk_status {
	uint8_t version;      /* 1 */
	uint8_t battery_pct;  /* 0-100 */
	uint16_t battery_mv;  /* 0 = unknown */
	uint16_t pv_mv;       /* solar cell voltage, 0 = not measured */
	uint8_t flags;        /* ST_* below */
	uint8_t fw_major;
	uint8_t fw_minor;
	uint8_t fw_patch;
};
#define ST_CHARGING  BIT(0)
#define ST_LOW_BATT  BIT(1)
#define ST_SEPARATED BIT(2)
#define ST_SOUND     BIT(3)
#define ST_TIME_SET  BIT(4)
#define ST_OWNED     BIT(5)

static struct styk_status status = {
	.version = 1, .fw_major = FW_MAJOR, .fw_minor = FW_MINOR, .fw_patch = FW_PATCH,
};
static bool notify_enabled;

/* ---------------- identity ---------------- */
static uint8_t device_id[8];
static char tag_code[5];           /* 4 hex characters, printed on the sticker */
static uint32_t pin;               /* 6-digit pairing PIN, printed on the sticker */
static uint8_t device_key[16];     /* encrypts the rotating ID */
static char name_pairing[12];      /* "Styk-XXXX" */
static const char name_owned[] = "Styk";

static void identity_init(void)
{
	ssize_t n = hwinfo_get_device_id(device_id, sizeof(device_id));

	if (n < 2) {
		memset(device_id, 0x5a, sizeof(device_id));
		n = sizeof(device_id);
	}
	snprintk(tag_code, sizeof(tag_code), "%02X%02X", device_id[n - 2], device_id[n - 1]);
	snprintk(name_pairing, sizeof(name_pairing), "Styk-%s", tag_code);

	/*
	 * PROTOTYPE ONLY. Development kits use the fixed PIN 123456 so you can pair
	 * without reading the serial console. Other boards derive a PIN from the chip ID.
	 * Production tags get a random PIN and key written at the factory, and the PIN
	 * is printed in the sticker's QR code.
	 */
#ifdef STYK_DEV_KIT
	pin = 123456;
#else
	pin = 100000 + (crc32_ieee(device_id, n) % 900000);
#endif

	static const uint8_t dev_master[16] = {
		's', 't', 'y', 'k', '-', 'd', 'e', 'v', '-', 'k', 'e', 'y', '-', 'v', '0', '1',
	};
	uint8_t block[16] = { 0 };

	memcpy(block, device_id, MIN((size_t)n, sizeof(block)));
	bt_encrypt_be(dev_master, block, device_key);
}

/* ---------------- ownership state ---------------- */
static bool owned;
static int64_t last_owner_ms;
static int64_t last_alert_ms;
static bool was_separated;
static struct bt_conn *current_conn;

static void count_bond(const struct bt_bond_info *info, void *user_data)
{
	ARG_UNUSED(info);
	(*(int *)user_data)++;
}

static bool has_bond(void)
{
	int n = 0;

	bt_foreach_bond(BT_ID_DEFAULT, count_bond, &n);
	return n > 0;
}

static bool is_separated(void)
{
	return owned && (k_uptime_get() - last_owner_ms) > SEPARATED_AFTER_MS;
}

/* ---------------- clock (set by the app) ---------------- */
static int64_t time_base_s;   /* Unix time at uptime zero, once the app has set it */

static uint32_t now_s(void)
{
	return (uint32_t)(time_base_s + k_uptime_get() / 1000);
}

/* ---------------- buzzer ---------------- */
/* On the nRF52 DK this drives LED1, so you can see the sound pattern. */
static const struct pwm_dt_spec buzzer = PWM_DT_SPEC_GET(DT_ALIAS(pwm_led0));

enum { BUZZ_NONE, BUZZ_FIND, BUZZ_CHIRP };
static atomic_t buzz_request;   /* what to play next */
static atomic_t buzz_stop;      /* set to cut the current pattern short */
K_SEM_DEFINE(buzz_sem, 0, 1);

static void notify_status(void);

static void tone(int ms)
{
	pwm_set_dt(&buzzer, PWM_HZ(4000), PWM_HZ(4000) / 2);
	k_msleep(ms);
	pwm_set_dt(&buzzer, PWM_HZ(4000), 0);
}

static void beeps(int count, int on_ms)
{
	for (int i = 0; i < count && !atomic_get(&buzz_stop); i++) {
		tone(on_ms);
		k_msleep(110);
	}
}

static void buzzer_thread(void *a, void *b, void *c)
{
	ARG_UNUSED(a);
	ARG_UNUSED(b);
	ARG_UNUSED(c);

	while (1) {
		k_sem_take(&buzz_sem, K_FOREVER);
		atomic_set(&buzz_stop, 0);
		int mode = (int)atomic_get(&buzz_request);

		status.flags |= ST_SOUND;
		notify_status();
		if (mode == BUZZ_FIND) {
			/* About 10 seconds of triple beeps. */
			for (int round = 0; round < 10 && !atomic_get(&buzz_stop); round++) {
				beeps(3, 120);
				if (!atomic_get(&buzz_stop)) {
					k_msleep(600);
				}
			}
		} else if (mode == BUZZ_CHIRP) {
			beeps(2, 150);
		}
		status.flags &= ~ST_SOUND;
		notify_status();
	}
}
K_THREAD_DEFINE(buzzer_tid, 1024, buzzer_thread, NULL, NULL, NULL, 7, 0, 0);

static void buzz(int mode)
{
	atomic_set(&buzz_stop, 1);   /* cut short whatever is playing */
	if (mode != BUZZ_NONE) {
		atomic_set(&buzz_request, mode);
		k_sem_give(&buzz_sem);
	}
}

/* ---------------- battery ---------------- */
#if DT_NODE_HAS_PROP(DT_PATH(zephyr_user), io_channels)
#include <zephyr/drivers/adc.h>
#define HAVE_BATTERY_ADC 1
#ifndef VBAT_DIVIDER_NUM
#define VBAT_DIVIDER_NUM 1   /* set to the battery divider ratio on the Styk board */
#define VBAT_DIVIDER_DEN 1
#endif
static const struct adc_dt_spec vbat = ADC_DT_SPEC_GET_BY_IDX(DT_PATH(zephyr_user), 0);
static bool adc_ok;

static void battery_init(void)
{
	adc_ok = adc_is_ready_dt(&vbat) && adc_channel_setup_dt(&vbat) == 0;
}

static int read_battery_mv(void)
{
	int16_t raw;
	int32_t mv;
	struct adc_sequence seq = { .buffer = &raw, .buffer_size = sizeof(raw) };

	if (!adc_ok || adc_sequence_init_dt(&vbat, &seq) || adc_read(vbat.dev, &seq)) {
		return 0;
	}
	mv = raw;
	if (adc_raw_to_millivolts_dt(&vbat, &mv)) {
		return 0;
	}
	return mv * VBAT_DIVIDER_NUM / VBAT_DIVIDER_DEN;
}
#else
static void battery_init(void)
{
}

static int read_battery_mv(void)
{
	return 0;   /* no battery measurement wired on this board */
}
#endif

static uint8_t battery_pct(int mv)
{
	if (mv <= 0) {
		return 100;   /* unknown: report full rather than alarm the owner */
	}
	if (mv <= BATT_EMPTY_MV) {
		return 0;
	}
	if (mv >= BATT_FULL_MV) {
		return 100;
	}
	return (uint8_t)((mv - BATT_EMPTY_MV) * 100 / (BATT_FULL_MV - BATT_EMPTY_MV));
}

/* ---------------- advertising ---------------- */
static uint8_t mfg[11];   /* company(2) version(1) rotating id(6) battery %(1) flags(1) */
static struct bt_data ad[] = {
	BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
	BT_DATA(BT_DATA_MANUFACTURER_DATA, mfg, sizeof(mfg)),
};
static struct bt_data sd[2];

static void build_adv_data(void)
{
	bool sep = is_separated();
	uint32_t epoch = now_s() / (sep ? SEPARATED_ROTATE_S : NEAR_OWNER_ROTATE_S);
	uint8_t plain[16] = { 0 };
	uint8_t enc[16];

	sys_put_le32(epoch, plain);
	plain[4] = sep ? 1 : 0;
	bt_encrypt_be(device_key, plain, enc);

	sys_put_le16(COMPANY_ID_TEST, mfg);
	mfg[2] = 1;   /* payload version */
	memcpy(&mfg[3], enc, 6);
	mfg[9] = status.battery_pct;
	mfg[10] = status.flags & (ST_CHARGING | ST_LOW_BATT | ST_SEPARATED | ST_OWNED);

	const char *name = owned ? name_owned : name_pairing;

	sd[0].type = BT_DATA_UUID128_ALL;
	sd[0].data_len = sizeof(svc_uuid_bytes);
	sd[0].data = svc_uuid_bytes;
	sd[1].type = BT_DATA_NAME_COMPLETE;
	sd[1].data_len = strlen(name);
	sd[1].data = (const uint8_t *)name;
}

static void adv_restart(struct k_work *work)
{
	ARG_UNUSED(work);
	uint16_t imin, imax;

	if (current_conn) {
		return;   /* advertising resumes after the connection ends */
	}
	if (!owned) {
		imin = ADV_PAIRING_MIN;
		imax = ADV_PAIRING_MAX;
	} else if (status.flags & ST_LOW_BATT) {
		imin = ADV_SLOW;
		imax = ADV_SLOW;
	} else {
		imin = ADV_NORMAL_MIN;
		imax = ADV_NORMAL_MAX;
	}

	struct bt_le_adv_param param = BT_LE_ADV_PARAM_INIT(ADV_OPTS, imin, imax, NULL);

	build_adv_data();
	bt_le_adv_stop();
	int err = bt_le_adv_start(&param, ad, ARRAY_SIZE(ad), sd, ARRAY_SIZE(sd));

	if (err && err != -EALREADY) {
		printk("Advertising failed to start (%d)\n", err);
	}
}
K_WORK_DEFINE(adv_work, adv_restart);

static void apply_name(void)
{
	bt_set_name(owned ? name_owned : name_pairing);
	if (owned) {
		status.flags |= ST_OWNED;
	} else {
		status.flags &= ~ST_OWNED;
	}
}

static void owner_seen(void)
{
	last_owner_ms = k_uptime_get();
	if (was_separated) {
		was_separated = false;
		status.flags &= ~ST_SEPARATED;
	}
}

/* ---------------- release ownership ---------------- */
static void release_fn(struct k_work *work)
{
	ARG_UNUSED(work);
	printk("Owner released this Styk. Back in pairing mode.\n");
	bt_unpair(BT_ID_DEFAULT, BT_ADDR_LE_ANY);   /* also ends the connection */
	owned = false;
	apply_name();
	k_work_submit(&adv_work);
}
K_WORK_DELAYABLE_DEFINE(release_work, release_fn);

/* ---------------- GATT ---------------- */
static ssize_t write_alert(struct bt_conn *conn, const struct bt_gatt_attr *attr,
			   const void *buf, uint16_t len, uint16_t offset, uint8_t flags)
{
	ARG_UNUSED(conn);
	ARG_UNUSED(attr);
	ARG_UNUSED(flags);

	if (offset != 0 || len != 1) {
		return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
	}
	switch (((const uint8_t *)buf)[0]) {
	case ALERT_STOP:
		buzz(BUZZ_NONE);
		break;
	case ALERT_FIND:
		buzz(BUZZ_FIND);
		break;
	case ALERT_CHIRP:
		buzz(BUZZ_CHIRP);
		break;
	default:
		return BT_GATT_ERR(BT_ATT_ERR_VALUE_NOT_ALLOWED);
	}
	owner_seen();
	return len;
}

static ssize_t write_control(struct bt_conn *conn, const struct bt_gatt_attr *attr,
			     const void *buf, uint16_t len, uint16_t offset, uint8_t flags)
{
	ARG_UNUSED(conn);
	ARG_UNUSED(attr);
	ARG_UNUSED(flags);
	const uint8_t *b = buf;

	if (offset != 0 || len < 1) {
		return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
	}
	switch (b[0]) {
	case CMD_RELEASE:
		if (len != 1) {
			return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
		}
		/* Let the write response go out before the link drops. */
		k_work_schedule(&release_work, K_MSEC(300));
		return len;
	case CMD_SET_TIME:
		if (len != 5) {
			return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
		}
		time_base_s = (int64_t)sys_get_le32(&b[1]) - k_uptime_get() / 1000;
		status.flags |= ST_TIME_SET;
		owner_seen();
		return len;
	default:
		return BT_GATT_ERR(BT_ATT_ERR_VALUE_NOT_ALLOWED);
	}
}

static ssize_t read_status(struct bt_conn *conn, const struct bt_gatt_attr *attr,
			   void *buf, uint16_t len, uint16_t offset)
{
	return bt_gatt_attr_read(conn, attr, buf, len, offset, &status, sizeof(status));
}

static ssize_t read_info(struct bt_conn *conn, const struct bt_gatt_attr *attr,
			 void *buf, uint16_t len, uint16_t offset)
{
	return bt_gatt_attr_read(conn, attr, buf, len, offset, tag_code, 4);
}

static void status_ccc_changed(const struct bt_gatt_attr *attr, uint16_t value)
{
	ARG_UNUSED(attr);
	notify_enabled = (value == BT_GATT_CCC_NOTIFY);
}

/* Every characteristic needs PIN-authenticated pairing, so only the owner can use it. */
BT_GATT_SERVICE_DEFINE(styk_svc,
	BT_GATT_PRIMARY_SERVICE(&svc_uuid),
	BT_GATT_CHARACTERISTIC(&alert_uuid.uuid, BT_GATT_CHRC_WRITE,
			       BT_GATT_PERM_WRITE_AUTHEN, NULL, write_alert, NULL),
	BT_GATT_CHARACTERISTIC(&control_uuid.uuid, BT_GATT_CHRC_WRITE,
			       BT_GATT_PERM_WRITE_AUTHEN, NULL, write_control, NULL),
	BT_GATT_CHARACTERISTIC(&status_uuid.uuid, BT_GATT_CHRC_READ | BT_GATT_CHRC_NOTIFY,
			       BT_GATT_PERM_READ_AUTHEN, read_status, NULL, NULL),
	BT_GATT_CCC(status_ccc_changed, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE_AUTHEN),
	BT_GATT_CHARACTERISTIC(&info_uuid.uuid, BT_GATT_CHRC_READ,
			       BT_GATT_PERM_READ_AUTHEN, read_info, NULL, NULL),
);
#define STATUS_VALUE_ATTR (&styk_svc.attrs[6])

static void notify_status(void)
{
	if (notify_enabled && current_conn) {
		bt_gatt_notify(current_conn, STATUS_VALUE_ATTR, &status, sizeof(status));
	}
}

/* ---------------- connection and pairing ---------------- */
static void connected(struct bt_conn *conn, uint8_t err)
{
	if (err) {
		return;
	}
	current_conn = bt_conn_ref(conn);
}

static void disconnected(struct bt_conn *conn, uint8_t reason)
{
	ARG_UNUSED(reason);
	if (current_conn == conn) {
		bt_conn_unref(current_conn);
		current_conn = NULL;
	}
	notify_enabled = false;
}

static void recycled(void)
{
	k_work_submit(&adv_work);
}

static void security_changed(struct bt_conn *conn, bt_security_t level, enum bt_security_err err)
{
	ARG_UNUSED(conn);
	if (!err && owned && level >= BT_SECURITY_L3) {
		owner_seen();
	}
}

BT_CONN_CB_DEFINE(conn_callbacks) = {
	.connected = connected,
	.disconnected = disconnected,
	.recycled = recycled,
	.security_changed = security_changed,
};

static void auth_passkey_display(struct bt_conn *conn, unsigned int passkey)
{
	ARG_UNUSED(conn);
	printk("Pairing: enter PIN %06u on the phone\n", passkey);
}

static void auth_cancel(struct bt_conn *conn)
{
	ARG_UNUSED(conn);
	printk("Pairing cancelled\n");
}

static enum bt_security_err pairing_accept(struct bt_conn *conn,
					   const struct bt_conn_pairing_feat *const feat)
{
	ARG_UNUSED(conn);
	ARG_UNUSED(feat);
	/* One owner at a time: the owner must release the tag before anyone else can claim it. */
	return owned ? BT_SECURITY_ERR_PAIR_NOT_ALLOWED : BT_SECURITY_ERR_SUCCESS;
}

static struct bt_conn_auth_cb auth_callbacks = {
	.passkey_display = auth_passkey_display,
	.cancel = auth_cancel,
	.pairing_accept = pairing_accept,
};

static void pairing_complete(struct bt_conn *conn, bool bonded)
{
	struct bt_conn_info info;

	if (bt_conn_get_info(conn, &info) || !bonded || info.security.level < BT_SECURITY_L3) {
		/* Pairing without the PIN does not make anyone the owner. */
		printk("Pairing without the PIN rejected\n");
		bt_unpair(BT_ID_DEFAULT, bt_conn_get_dst(conn));
		return;
	}
	owned = true;
	apply_name();
	owner_seen();
	printk("Paired. This Styk now has an owner.\n");
}

static void pairing_failed(struct bt_conn *conn, enum bt_security_err reason)
{
	ARG_UNUSED(conn);
	printk("Pairing failed (%d)\n", reason);
}

static struct bt_conn_auth_info_cb auth_info_callbacks = {
	.pairing_complete = pairing_complete,
	.pairing_failed = pairing_failed,
};

/* ---------------- housekeeping, once a minute ---------------- */
static int last_mv;
static int charging_ticks;

static void update_battery(void)
{
	int mv = read_battery_mv();

	if (mv > 0 && last_mv > 0 && mv - last_mv >= CHARGE_RISE_MV) {
		charging_ticks = 2;   /* the "solar charge good" signal: voltage rising */
	} else if (charging_ticks > 0) {
		charging_ticks--;
	}
	if (mv > 0) {
		last_mv = mv;
	}

	status.battery_mv = sys_cpu_to_le16((uint16_t)MAX(mv, 0));
	status.battery_pct = battery_pct(mv);
	status.pv_mv = 0;   /* TODO: measure the solar cell on the Styk board */
	WRITE_BIT(status.flags, 0, charging_ticks > 0);                         /* ST_CHARGING */
	WRITE_BIT(status.flags, 1, status.battery_pct < LOW_BATTERY_PCT);       /* ST_LOW_BATT */
	bt_bas_set_battery_level(status.battery_pct);
}

static void housekeeping_fn(struct k_work *work);
K_WORK_DELAYABLE_DEFINE(housekeeping, housekeeping_fn);

static void housekeeping_fn(struct k_work *work)
{
	ARG_UNUSED(work);
	bool was_low = status.flags & ST_LOW_BATT;

	update_battery();

	bool sep = is_separated();

	if (sep != was_separated) {
		was_separated = sep;
		WRITE_BIT(status.flags, 2, sep);   /* ST_SEPARATED */
		printk(sep ? "Separated from owner\n" : "Owner nearby\n");
	}

	if (owned) {
		int64_t now = k_uptime_get();

		if (now - last_owner_ms > ALERT_AFTER_MS && now - last_alert_ms > ALERT_AFTER_MS) {
			last_alert_ms = now;
			buzz(BUZZ_CHIRP);   /* audible alert: away from the owner for hours */
		}
	}

	if (!current_conn) {
		if ((bool)(status.flags & ST_LOW_BATT) != was_low) {
			k_work_submit(&adv_work);   /* new interval */
		} else {
			build_adv_data();           /* new rotating ID, battery and flags */
			bt_le_adv_update_data(ad, ARRAY_SIZE(ad), sd, ARRAY_SIZE(sd));
		}
	}
	notify_status();
	k_work_schedule(&housekeeping, K_SECONDS(HOUSEKEEPING_S));
}

/* ---------------- development kit: hold Button 1 while resetting to clear the owner ---------------- */
#if DT_NODE_EXISTS(DT_ALIAS(sw0))
static const struct gpio_dt_spec reset_button = GPIO_DT_SPEC_GET(DT_ALIAS(sw0), gpios);

static bool button_held(void)
{
	if (!gpio_is_ready_dt(&reset_button) ||
	    gpio_pin_configure_dt(&reset_button, GPIO_INPUT)) {
		return false;
	}
	return gpio_pin_get_dt(&reset_button) > 0;
}
#else
static bool button_held(void)
{
	return false;
}
#endif

int main(void)
{
	int err;

	printk("\nStyk firmware %d.%d.%d\n", FW_MAJOR, FW_MINOR, FW_PATCH);

	if (!pwm_is_ready_dt(&buzzer)) {
		printk("Buzzer output not ready\n");
	}
	battery_init();

	err = bt_enable(NULL);
	if (err) {
		printk("Bluetooth failed to start (%d)\n", err);
		return 0;
	}
	if (IS_ENABLED(CONFIG_SETTINGS)) {
		settings_load();
	}

	identity_init();
	bt_passkey_set(pin);
	bt_conn_auth_cb_register(&auth_callbacks);
	bt_conn_auth_info_cb_register(&auth_info_callbacks);

	if (button_held()) {
		bt_unpair(BT_ID_DEFAULT, BT_ADDR_LE_ANY);
		printk("Button held at start: owner cleared\n");
	}
	owned = has_bond();
	apply_name();
	update_battery();
	last_owner_ms = k_uptime_get();

	printk("Tag code %s, PIN %06u\n", tag_code, pin);
	printk("Pairing link: https://thestyk.com/app/?tag=%s&pin=%06u\n", tag_code, pin);
	printk(owned ? "Owner: yes\n" : "Owner: none (pairing mode)\n");

	k_work_submit(&adv_work);
	k_work_schedule(&housekeeping, K_SECONDS(HOUSEKEEPING_S));
	return 0;
}
