// A pulled copy of a live site still runs the live site's plugins and
// settings: the first page load fires wp-cron, which can send real emails,
// upload backups to the real storage, report to a management dashboard or
// charge cards. "Make the copy safe" neutralizes that during the pull:
//
// 1. Before the database import: the safety mu-plugin (no outgoing HTTP, no
//    email) and the SSH_SYNC_LOCAL_COPY constant that switches it on.
// 2. Right after the import, before WordPress loads: unsafe plugins
//    deactivated and WooCommerce Stripe switched to test mode, straight in the
//    database. What was changed is kept as a NeutralizeRecord, so a later
//    database push puts it back on the server instead of shipping a
//    neutralized site.

export const SAFETY_MU_PLUGIN = 'ssh-sync-local-safety.php';
export const SAFETY_MU_PLUGIN_PATH = `wp-content/mu-plugins/${SAFETY_MU_PLUGIN}`;
export const LOCAL_COPY_CONSTANT = 'SSH_SYNC_LOCAL_COPY';

// Plugins that send email, push backups off-site or report to a remote
// dashboard. Matched on the plugin folder.
export const UNSAFE_PLUGIN_FOLDERS = [
  // Off-site backups
  'updraftplus',
  'backwpup',
  'blogvault-real-time-backup',
  'wpvivid-backuprestore',
  // Remote management
  'mainwp-child',
  'mainwp-child-reports',
  'worker',
  'iwp-client',
  // Mail delivery
  'fluent-smtp',
  'wp-mail-smtp',
  'post-smtp',
  'easy-wp-smtp',
  'mailpoet',
  'wp-ses',
  'mailgun',
  'sendgrid-email-delivery-simplified',
  // Security plugins that email alerts and lock out the copy
  'wordfence',
];

// Blocks every outgoing HTTP request except to WordPress.org and local hosts,
// and every email. Active only where wp-config.php defines SSH_SYNC_LOCAL_COPY
// (the Local site's own wp-config.php, which is never synced). Pushes exclude
// the file itself.
export const SAFETY_MU_PLUGIN_SOURCE = `<?php
/**
 * Plugin Name: SSH Sync: local copy safety
 * Description: Added by the SSH Sync add-on for Local when it pulls a site. Blocks outgoing HTTP requests (except WordPress.org and local hosts) and all email, so this copy of a live site cannot reach real services. Delete this file, or the SSH_SYNC_LOCAL_COPY line in wp-config.php, to turn the protection off. SSH Sync never pushes it.
 */

if ( ! defined( '${LOCAL_COPY_CONSTANT}' ) || ! ${LOCAL_COPY_CONSTANT} ) {
	return;
}

add_filter(
	'pre_http_request',
	function ( $preempt, $args, $url ) {
		$host    = (string) wp_parse_url( $url, PHP_URL_HOST );
		$allowed = array(
			(string) wp_parse_url( home_url(), PHP_URL_HOST ),
			'localhost',
			'127.0.0.1',
			'api.wordpress.org',
			'downloads.wordpress.org',
		);
		if ( in_array( $host, $allowed, true ) || preg_match( '/\\.local$/', $host ) ) {
			return $preempt;
		}
		error_log( 'SSH Sync local safety blocked: ' . $url );
		return new WP_Error( 'ssh_sync_local_blocked', 'Blocked on this local copy: ' . $url );
	},
	1,
	3
);

add_filter( 'pre_wp_mail', '__return_false', 1 );
add_filter( 'action_scheduler_allow_async_request_runner', '__return_false' );
`;

// What the neutralize step changed, per table suffix (relative to the table
// prefix, so it still applies after a prefix change): plugins it deactivated
// and the Stripe test mode it replaced.
export interface NeutralizeRecord {
  // The environment the database was pulled from: the only one a database
  // push may restore these settings on
  environmentId?: string;
  options: Record<string, { deactivated: string[]; stripeTestmode: string | null }>;
  sitewideDeactivated: Record<string, number>;
}

export interface NeutralizeResult {
  deactivated: string[];
  stripe: boolean;
  record: NeutralizeRecord;
}

// Run with Local's PHP CLI against the Local site's MySQL socket:
//   php neutralize.php <socket> <user> <password> <db> <prefix> <folders json>
// Covers every options table (multisite subsites included) and the network's
// active_sitewide_plugins. Prints a NeutralizeResult as JSON.
export const NEUTRALIZE_SCRIPT = `<?php
mysqli_report( MYSQLI_REPORT_OFF );
list( , $socket, $user, $password, $name, $prefix, $folders_json ) = $argv;
$db = new mysqli( 'localhost', $user, $password, $name, 0, $socket );
if ( $db->connect_errno ) {
	fwrite( STDERR, 'Could not connect to the local database: ' . $db->connect_error );
	exit( 1 );
}
$db->set_charset( 'utf8mb4' );
$folders = json_decode( $folders_json, true );
$is_unsafe = function ( $plugin ) use ( $folders ) {
	return in_array( strtok( (string) $plugin, '/' ), $folders, true );
};
$get = function ( $table, $key_column, $value_column, $key ) use ( $db ) {
	$st = $db->prepare( "SELECT \`$value_column\` FROM \`$table\` WHERE \`$key_column\` = ? LIMIT 1" );
	$st->bind_param( 's', $key );
	$st->execute();
	$row = $st->get_result()->fetch_row();
	return $row ? @unserialize( $row[0] ) : null;
};
$set = function ( $table, $key_column, $value_column, $key, $value ) use ( $db ) {
	$st = $db->prepare( "UPDATE \`$table\` SET \`$value_column\` = ? WHERE \`$key_column\` = ?" );
	$v  = serialize( $value );
	$st->bind_param( 'ss', $v, $key );
	if ( ! $st->execute() ) {
		fwrite( STDERR, "Could not update $key in $table" );
		exit( 1 );
	}
};

$like   = $db->real_escape_string( str_replace( '_', '\\\\_', $prefix ) );
$tables = array();
foreach ( $db->query( "SHOW TABLES LIKE '{$like}%options'" )->fetch_all() as $row ) {
	$suffix = substr( $row[0], strlen( $prefix ) );
	if ( 'options' === $suffix || preg_match( '/^[0-9]+_options$/', $suffix ) ) {
		$tables[] = $suffix;
	}
}
if ( ! in_array( 'options', $tables, true ) ) {
	fwrite( STDERR, "No {$prefix}options table" );
	exit( 1 );
}

$record      = array( 'options' => array(), 'sitewideDeactivated' => new stdClass() );
$deactivated = array();
$stripe_any  = false;
foreach ( $tables as $suffix ) {
	$table  = $prefix . $suffix;
	$entry  = array( 'deactivated' => array(), 'stripeTestmode' => null );
	$active = $get( $table, 'option_name', 'option_value', 'active_plugins' );
	if ( is_array( $active ) ) {
		$kept = array();
		foreach ( $active as $plugin ) {
			if ( $is_unsafe( $plugin ) ) {
				$entry['deactivated'][] = $plugin;
			} else {
				$kept[] = $plugin;
			}
		}
		if ( $entry['deactivated'] ) {
			$set( $table, 'option_name', 'option_value', 'active_plugins', array_values( $kept ) );
		}
	}
	$stripe = $get( $table, 'option_name', 'option_value', 'woocommerce_stripe_settings' );
	if ( is_array( $stripe ) && 'yes' !== ( $stripe['testmode'] ?? '' ) ) {
		$entry['stripeTestmode'] = (string) ( $stripe['testmode'] ?? '' );
		$stripe['testmode']      = 'yes';
		$set( $table, 'option_name', 'option_value', 'woocommerce_stripe_settings', $stripe );
		$stripe_any = true;
	}
	if ( $entry['deactivated'] || null !== $entry['stripeTestmode'] ) {
		$record['options'][ $suffix ] = $entry;
		$deactivated                  = array_merge( $deactivated, $entry['deactivated'] );
	}
}

$sitemeta = $prefix . 'sitemeta';
if ( $db->query( "SHOW TABLES LIKE '" . $db->real_escape_string( str_replace( '_', '\\\\_', $sitemeta ) ) . "'" )->num_rows ) {
	// The main network only (site_id 1): every network has its own row
	$st = $db->prepare( "SELECT meta_value FROM \`$sitemeta\` WHERE meta_key = 'active_sitewide_plugins' AND site_id = 1 LIMIT 1" );
	$st->execute();
	$row     = $st->get_result()->fetch_row();
	$network = $row ? @unserialize( $row[0] ) : null;
	if ( is_array( $network ) ) {
		$removed = array();
		foreach ( $network as $plugin => $time ) {
			if ( $is_unsafe( $plugin ) ) {
				$removed[ $plugin ] = $time;
				unset( $network[ $plugin ] );
			}
		}
		if ( $removed ) {
			$st = $db->prepare( "UPDATE \`$sitemeta\` SET meta_value = ? WHERE meta_key = 'active_sitewide_plugins' AND site_id = 1" );
			$v  = serialize( $network );
			$st->bind_param( 's', $v );
			if ( ! $st->execute() ) {
				fwrite( STDERR, 'Could not update active_sitewide_plugins' );
				exit( 1 );
			}
			$record['sitewideDeactivated'] = $removed;
			$deactivated                   = array_merge( $deactivated, array_keys( $removed ) );
		}
	}
}

echo json_encode(
	array(
		'deactivated' => array_values( array_unique( $deactivated ) ),
		'stripe'      => $stripe_any,
		'record'      => $record,
	)
);
`;

export function parseNeutralizeOutput(stdout: string): NeutralizeResult | null {
  const line = stdout.trim().split('\n').pop() || '';
  try {
    const parsed = JSON.parse(line);
    if (!Array.isArray(parsed.deactivated) || typeof parsed.record !== 'object') return null;
    return {
      deactivated: parsed.deactivated.map(String),
      stripe: Boolean(parsed.stripe),
      record: {
        options:
          parsed.record.options && !Array.isArray(parsed.record.options)
            ? parsed.record.options
            : {},
        sitewideDeactivated:
          parsed.record.sitewideDeactivated && !Array.isArray(parsed.record.sitewideDeactivated)
            ? parsed.record.sitewideDeactivated
            : {},
      },
    };
  } catch {
    return null;
  }
}

export function isEmptyRecord(
  record: Pick<NeutralizeRecord, 'options' | 'sitewideDeactivated'>,
): boolean {
  return (
    Object.keys(record.options).length === 0 && Object.keys(record.sitewideDeactivated).length === 0
  );
}

// Runs on the server with `wp --skip-plugins --skip-themes eval-file -` after a
// database push: re-activates what the safe copy deactivated (keeping anything
// activated locally since) and restores Stripe's test mode where the copy still
// has the value the safe step set.
export function restoreNeutralizedScript(record: NeutralizeRecord): string {
  const payload = Buffer.from(JSON.stringify(record), 'utf8').toString('base64');
  return `<?php
global $wpdb;
$record   = json_decode( base64_decode( '${payload}' ), true );
$restored = array();
foreach ( $record['options'] as $suffix => $entry ) {
	if ( ! preg_match( '/^([0-9]+_)?options$/', $suffix ) ) {
		continue;
	}
	$table = $wpdb->base_prefix . $suffix;
	if ( $table !== $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $wpdb->esc_like( $table ) ) ) ) {
		fwrite( STDERR, "No table $table on the server" );
		exit( 1 );
	}
	$read  = function ( $option ) use ( $wpdb, $table ) {
		return maybe_unserialize( $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM \`$table\` WHERE option_name = %s", $option ) ) );
	};
	$write = function ( $option, $value ) use ( $wpdb, $table ) {
		if ( false === $wpdb->update( $table, array( 'option_value' => maybe_serialize( $value ) ), array( 'option_name' => $option ) ) ) {
			fwrite( STDERR, "Could not update $option in $table" );
			exit( 1 );
		}
	};
	if ( ! empty( $entry['deactivated'] ) ) {
		$active = $read( 'active_plugins' );
		$active = is_array( $active ) ? $active : array();
		$merged = array_values( array_unique( array_merge( $active, $entry['deactivated'] ) ) );
		sort( $merged );
		$write( 'active_plugins', $merged );
		$restored = array_merge( $restored, $entry['deactivated'] );
	}
	if ( null !== $entry['stripeTestmode'] ) {
		$stripe = $read( 'woocommerce_stripe_settings' );
		if ( is_array( $stripe ) && 'yes' === ( $stripe['testmode'] ?? '' ) ) {
			$stripe['testmode'] = $entry['stripeTestmode'];
			$write( 'woocommerce_stripe_settings', $stripe );
			$restored[] = 'stripe-testmode';
		}
	}
}
if ( ! empty( $record['sitewideDeactivated'] ) && ! empty( $wpdb->sitemeta ) ) {
	// The main network only, like the neutralize step
	$network = maybe_unserialize( $wpdb->get_var( $wpdb->prepare( "SELECT meta_value FROM {$wpdb->sitemeta} WHERE meta_key = %s AND site_id = 1", 'active_sitewide_plugins' ) ) );
	$network = is_array( $network ) ? $network : array();
	$network = $network + $record['sitewideDeactivated'];
	if ( false === $wpdb->update( $wpdb->sitemeta, array( 'meta_value' => maybe_serialize( $network ) ), array( 'meta_key' => 'active_sitewide_plugins', 'site_id' => 1 ) ) ) {
		fwrite( STDERR, 'Could not update active_sitewide_plugins' );
		exit( 1 );
	}
	$restored = array_merge( $restored, array_keys( $record['sitewideDeactivated'] ) );
}
wp_cache_flush();
echo wp_json_encode( array( 'restored' => array_values( array_unique( $restored ) ) ) );
`;
}

const LITERAL_ENVIRONMENT_TYPE_RE =
  /define\s*\(\s*['"]WP_ENVIRONMENT_TYPE['"]\s*,\s*['"][^'"]*['"]\s*\)\s*;/;
const ANY_ENVIRONMENT_TYPE_RE = /define\s*\(\s*['"]WP_ENVIRONMENT_TYPE['"]/;
const LOCAL_COPY_RE = new RegExp(`define\\s*\\(\\s*['"]${LOCAL_COPY_CONSTANT}['"]`);
const STOP_EDITING_RE = /\/\*\s*That's all, stop editing!/;

function insertBeforeSettings(wpConfig: string, line: string): string {
  if (STOP_EDITING_RE.test(wpConfig)) {
    return wpConfig.replace(STOP_EDITING_RE, (marker) => `${line}\n\n${marker}`);
  }
  const requireSettings = wpConfig.search(
    /require_once\s*\(?\s*ABSPATH\s*\.\s*['"]wp-settings\.php/,
  );
  if (requireSettings >= 0) {
    return `${wpConfig.slice(0, requireSettings)}${line}\n${wpConfig.slice(requireSettings)}`;
  }
  return `${wpConfig.trimEnd()}\n${line}\n`;
}

// In the Local site's own wp-config.php (never synced): the constant that
// switches the safety mu-plugin on, and WP_ENVIRONMENT_TYPE=local for every
// environment-aware plugin. A WP_ENVIRONMENT_TYPE that is not a plain string
// (getenv(), a constant) is left alone: redefining it would warn on every
// request, and the safety does not depend on it.
export function ensureLocalCopyConfig(wpConfig: string): string {
  let config = wpConfig;
  if (!LOCAL_COPY_RE.test(config)) {
    config = insertBeforeSettings(config, `define( '${LOCAL_COPY_CONSTANT}', true );`);
  }
  const environmentType = "define( 'WP_ENVIRONMENT_TYPE', 'local' );";
  if (LITERAL_ENVIRONMENT_TYPE_RE.test(config)) {
    config = config.replace(LITERAL_ENVIRONMENT_TYPE_RE, environmentType);
  } else if (!ANY_ENVIRONMENT_TYPE_RE.test(config)) {
    config = insertBeforeSettings(config, environmentType);
  }
  return config;
}

export function describeSafeClone(
  result: Pick<NeutralizeResult, 'deactivated' | 'stripe'>,
): string {
  const parts: string[] = [];
  if (result.deactivated.length) {
    parts.push(`deactivated ${result.deactivated.map((p) => p.split('/')[0]).join(', ')}`);
  }
  if (result.stripe) parts.push('put Stripe in test mode');
  parts.push('blocked outgoing requests and email');
  return `Made the copy safe: ${parts.join('; ')}.`;
}
