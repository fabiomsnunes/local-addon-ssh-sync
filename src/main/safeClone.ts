// A pulled copy of a live site still runs the live site's plugins and
// settings: the first page load fires wp-cron, which can send real emails,
// upload backups to the real storage, report to a management dashboard or
// charge cards. "Make the clone safe" neutralizes that right after the pull,
// before WordPress loads.

export const SAFETY_MU_PLUGIN = 'ssh-sync-local-safety.php';
export const SAFETY_MU_PLUGIN_PATH = `wp-content/mu-plugins/${SAFETY_MU_PLUGIN}`;

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
// and every email. Active only where WP_ENVIRONMENT_TYPE is `local` (set in the
// Local site's wp-config.php, which is never synced). Pushes exclude it.
export const SAFETY_MU_PLUGIN_SOURCE = `<?php
/**
 * Plugin Name: SSH Sync: local clone safety
 * Description: Added by the SSH Sync add-on for Local after a pull. Blocks outgoing HTTP requests (except WordPress.org and local hosts) and all email, so this copy of a live site cannot reach real services. Delete this file to turn the protection off. SSH Sync never pushes it.
 */

if ( 'local' !== wp_get_environment_type() ) {
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

// Run with Local's PHP CLI: php neutralize.php <socket> <user> <password> <db> <prefix> <folders json>
// Deactivates the unsafe plugins and puts WooCommerce Stripe in test mode
// without keys, straight in the database, before WordPress ever loads.
export const NEUTRALIZE_SCRIPT = `<?php
mysqli_report( MYSQLI_REPORT_OFF );
list( , $socket, $user, $password, $name, $prefix, $folders_json ) = $argv;
$db = new mysqli( 'localhost', $user, $password, $name, 0, $socket );
if ( $db->connect_errno ) {
	fwrite( STDERR, 'Could not connect to the local database: ' . $db->connect_error );
	exit( 1 );
}
$table   = $prefix . 'options';
$folders = json_decode( $folders_json, true );
$get     = function ( $option ) use ( $db, $table ) {
	$st = $db->prepare( "SELECT option_value FROM \`$table\` WHERE option_name = ?" );
	$st->bind_param( 's', $option );
	$st->execute();
	$row = $st->get_result()->fetch_row();
	return $row ? @unserialize( $row[0] ) : null;
};
$set = function ( $option, $value ) use ( $db, $table ) {
	$st = $db->prepare( "UPDATE \`$table\` SET option_value = ? WHERE option_name = ?" );
	$v  = serialize( $value );
	$st->bind_param( 'ss', $v, $option );
	if ( ! $st->execute() ) {
		fwrite( STDERR, 'Could not update ' . $option );
		exit( 1 );
	}
};
$active = $get( 'active_plugins' );
if ( ! is_array( $active ) ) {
	fwrite( STDERR, 'No active_plugins option in ' . $table );
	exit( 1 );
}
$kept        = array();
$deactivated = array();
foreach ( $active as $plugin ) {
	if ( in_array( strtok( (string) $plugin, '/' ), $folders, true ) ) {
		$deactivated[] = $plugin;
	} else {
		$kept[] = $plugin;
	}
}
if ( $deactivated ) {
	$set( 'active_plugins', array_values( $kept ) );
}
$stripe = $get( 'woocommerce_stripe_settings' );
$stripe_changed = false;
if ( is_array( $stripe ) ) {
	$stripe['testmode'] = 'yes';
	foreach ( array( 'publishable_key', 'secret_key', 'webhook_secret' ) as $key ) {
		if ( isset( $stripe[ $key ] ) ) {
			$stripe[ $key ] = '';
		}
	}
	$set( 'woocommerce_stripe_settings', $stripe );
	$stripe_changed = true;
}
echo json_encode( array( 'deactivated' => $deactivated, 'stripe' => $stripe_changed ) );
`;

export interface NeutralizeResult {
  deactivated: string[];
  stripe: boolean;
}

export function parseNeutralizeOutput(stdout: string): NeutralizeResult | null {
  const line = stdout.trim().split('\n').pop() || '';
  try {
    const parsed = JSON.parse(line);
    if (!Array.isArray(parsed.deactivated)) return null;
    return { deactivated: parsed.deactivated.map(String), stripe: Boolean(parsed.stripe) };
  } catch {
    return null;
  }
}

const ENVIRONMENT_TYPE_RE =
  /define\s*\(\s*['"]WP_ENVIRONMENT_TYPE['"]\s*,\s*['"][^'"]*['"]\s*\)\s*;/;
const STOP_EDITING_RE = /\/\*\s*That's all, stop editing!/;

// Mark the Local site as `local` in its own wp-config.php (never synced), so
// the safety mu-plugin and every environment-aware plugin know where they run.
export function ensureLocalEnvironmentType(wpConfig: string): string {
  const define = "define( 'WP_ENVIRONMENT_TYPE', 'local' );";
  if (ENVIRONMENT_TYPE_RE.test(wpConfig)) return wpConfig.replace(ENVIRONMENT_TYPE_RE, define);
  if (STOP_EDITING_RE.test(wpConfig)) {
    return wpConfig.replace(STOP_EDITING_RE, (marker) => `${define}\n\n${marker}`);
  }
  const requireSettings = wpConfig.search(
    /require_once\s*\(?\s*ABSPATH\s*\.\s*['"]wp-settings\.php/,
  );
  if (requireSettings >= 0) {
    return `${wpConfig.slice(0, requireSettings)}${define}\n${wpConfig.slice(requireSettings)}`;
  }
  return `${wpConfig.trimEnd()}\n${define}\n`;
}

export function describeSafeClone(result: NeutralizeResult): string {
  const parts: string[] = [];
  if (result.deactivated.length) {
    parts.push(`deactivated ${result.deactivated.map((p) => p.split('/')[0]).join(', ')}`);
  }
  if (result.stripe) parts.push('put Stripe in test mode');
  parts.push('blocked outgoing requests and email');
  return `Made the copy safe: ${parts.join('; ')}.`;
}
