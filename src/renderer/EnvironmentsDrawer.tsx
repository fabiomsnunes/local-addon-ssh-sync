import * as React from 'react';
import { useState, useEffect } from 'react';
import { PrimaryButton, TextButton, Checkbox, Spinner, Title } from './localComponents';
import SyncIcon from './SyncIcon';
import { environmentTarget, remoteDomainOf } from './pushHelpers';
import { STATUS, tint } from './colors';
import { ServerEnvironment, SiteProfile } from './types';

const { ipcRenderer } = window.require('electron');

const MANUAL_CONNECTION = '__manual__';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (profile: SiteProfile) => void;
  site: any;
  environments: ServerEnvironment[];
}

// The form keeps every field as text; the main process validates and
// normalizes on save and on Test connection.
interface EnvironmentForm {
  id?: string;
  label: string;
  connection: string; // an ~/.ssh/config alias, or MANUAL_CONNECTION
  sshHost: string;
  sshUser: string;
  sshPort: string;
  auth: 'key' | 'password';
  // Typed in this form only; empty keeps the saved password
  password: string;
  hasPassword: boolean;
  remotePath: string;
  remoteUrl: string;
  wpCommand: string;
  cacheCommand: string;
  extraExcludes: string;
  isProduction: boolean;
}

function formFromEnvironment(env: ServerEnvironment): EnvironmentForm {
  return {
    id: env.id,
    label: env.label,
    connection: env.sshAlias || MANUAL_CONNECTION,
    sshHost: env.sshHost || '',
    sshUser: env.sshUser || '',
    sshPort: env.sshPort || '22',
    auth: env.auth,
    password: '',
    hasPassword: Boolean(env.hasPassword),
    remotePath: env.remotePath,
    remoteUrl: env.remoteUrl,
    wpCommand: env.wpCommand || 'wp',
    cacheCommand: env.cacheCommand || '',
    extraExcludes: (env.extraExcludes || []).join('\n'),
    isProduction: env.isProduction,
  };
}

function newForm(isFirst: boolean): EnvironmentForm {
  return {
    label: isFirst ? 'Production' : 'Staging',
    connection: MANUAL_CONNECTION,
    sshHost: '',
    sshUser: '',
    sshPort: '22',
    auth: 'key',
    password: '',
    hasPassword: false,
    remotePath: '',
    remoteUrl: '',
    wpCommand: 'wp',
    cacheCommand: '',
    extraExcludes: '',
    isProduction: isFirst,
  };
}

function environmentFromForm(
  form: EnvironmentForm,
): Partial<ServerEnvironment> & { password?: string } {
  const usesAlias = form.connection !== MANUAL_CONNECTION;
  return {
    id: form.id,
    label: form.label,
    sshAlias: usesAlias ? form.connection : undefined,
    sshHost: usesAlias ? undefined : form.sshHost,
    sshUser: usesAlias ? undefined : form.sshUser,
    sshPort: usesAlias ? undefined : form.sshPort,
    auth: form.auth,
    password: form.auth === 'password' && form.password ? form.password : undefined,
    remotePath: form.remotePath,
    remoteUrl: form.remoteUrl,
    wpCommand: form.wpCommand,
    cacheCommand: form.cacheCommand || undefined,
    extraExcludes: form.extraExcludes
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean),
    isProduction: form.isProduction,
  };
}

const fieldLabelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: '6px',
  fontWeight: 600,
  fontSize: '13px',
};

const hintStyle: React.CSSProperties = {
  display: 'block',
  marginTop: '4px',
  fontSize: '12px',
  opacity: 0.6,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  borderRadius: '4px',
  border: '1px solid #3e3e3e',
  backgroundColor: '#1e1e1e',
  color: 'inherit',
  fontSize: '13px',
  fontFamily: 'inherit',
};

const monoInputStyle: React.CSSProperties = { ...inputStyle, fontFamily: 'monospace' };

const fieldStyle: React.CSSProperties = { marginBottom: '18px' };

// Drawer to add, edit and remove the servers a Local site syncs with. Saving
// writes the whole list through the main process, which validates every entry.
const EnvironmentsDrawer: React.FC<Props> = ({ isOpen, onClose, onSaved, site, environments }) => {
  const [sshHosts, setSshHosts] = useState<string[]>([]);
  const [form, setForm] = useState<EnvironmentForm | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testState, setTestState] = useState<
    | { status: 'busy' }
    | { status: 'ok'; remoteRoot: string }
    | { status: 'error'; error: string }
    | null
  >(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setTestState(null);
    setConfirmRemoveId(null);
    // Straight to the form when there is nothing to list yet
    setForm(environments.length === 0 ? newForm(true) : null);
    ipcRenderer.invoke('sshsync:listSshHosts').then((hosts: string[]) => setSshHosts(hosts || []));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the drawer opens
  }, [isOpen]);

  const updateForm = (changes: Partial<EnvironmentForm>) => {
    setForm((current) => (current ? { ...current, ...changes } : current));
    setTestState(null);
  };

  const persist = async (
    next: (Partial<ServerEnvironment> & { password?: string })[],
  ): Promise<boolean> => {
    setIsSaving(true);
    setError(null);
    const result = await ipcRenderer.invoke('sshsync:saveEnvironments', site.id, next);
    setIsSaving(false);
    if (!result.success) {
      setError(result.error || 'Could not save the environments');
      return false;
    }
    onSaved(result.profile);
    return true;
  };

  const handleSaveForm = async () => {
    if (!form) return;
    const edited = environmentFromForm(form);
    const next = form.id
      ? environments.map((env) => (env.id === form.id ? edited : env))
      : [...environments, edited];
    if (await persist(next)) setForm(null);
  };

  const handleRemove = async (environmentId: string) => {
    if (confirmRemoveId !== environmentId) {
      setConfirmRemoveId(environmentId);
      return;
    }
    setConfirmRemoveId(null);
    await persist(environments.filter((env) => env.id !== environmentId));
  };

  const handleTestConnection = async () => {
    if (!form) return;
    setTestState({ status: 'busy' });
    const result = await ipcRenderer.invoke('sshsync:testConnection', environmentFromForm(form));
    setTestState(
      result.success
        ? { status: 'ok', remoteRoot: result.remoteRoot }
        : { status: 'error', error: result.error || 'Connection failed' },
    );
  };

  const handleClose = () => {
    if (isSaving) return;
    setForm(null);
    onClose();
  };

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    zIndex: 9998,
    opacity: isOpen ? 1 : 0,
    visibility: isOpen ? 'visible' : 'hidden',
    transition: 'opacity 0.3s ease, visibility 0.3s ease',
  };

  const drawerStyle: React.CSSProperties = {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    width: '520px',
    backgroundColor: '#292929',
    zIndex: 9999,
    transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
    transition: 'transform 0.3s ease',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '-4px 0 20px rgba(0, 0, 0, 0.3)',
  };

  const headerStyle: React.CSSProperties = {
    padding: '20px 24px',
    borderBottom: '1px solid #3e3e3e',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  };

  const contentStyle: React.CSSProperties = {
    flex: 1,
    padding: '24px',
    overflowY: 'auto',
  };

  const footerStyle: React.CSSProperties = {
    padding: '16px 24px',
    borderTop: '1px solid #3e3e3e',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
  };

  const connectionOptions: Record<string, string> = {
    [MANUAL_CONNECTION]: 'Host, user and port',
    ...Object.fromEntries(sshHosts.map((host) => [host, `${host} (~/.ssh/config)`])),
  };
  // A saved alias that is no longer in ~/.ssh/config still has to be selectable
  if (form && form.connection !== MANUAL_CONNECTION && !connectionOptions[form.connection]) {
    connectionOptions[form.connection] = form.connection;
  }

  const errorBox = (message: string) => (
    <div
      style={{
        marginTop: '16px',
        padding: '12px 16px',
        backgroundColor: tint(STATUS.danger, 0.1),
        border: `1px solid ${tint(STATUS.danger, 0.3)}`,
        borderRadius: '8px',
        color: STATUS.danger,
        fontSize: '13px',
        whiteSpace: 'pre-wrap',
      }}
    >
      {message}
    </div>
  );

  return (
    <>
      <div style={overlayStyle} onClick={handleClose} />

      <div style={drawerStyle}>
        <div style={headerStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <SyncIcon size={28} />
            <div>
              <Title size="s" style={{ margin: 0 }}>
                {form ? (form.id ? `Edit ${form.label}` : 'Add a server') : 'Environments'}
              </Title>
              <span style={{ fontSize: '13px', opacity: 0.7 }}>{site.name || site.domain}</span>
            </div>
          </div>
          <button
            onClick={handleClose}
            disabled={isSaving}
            style={{
              background: 'none',
              border: 'none',
              cursor: isSaving ? 'not-allowed' : 'pointer',
              padding: '8px',
              opacity: isSaving ? 0.5 : 1,
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#888"
              strokeWidth="2"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div style={contentStyle}>
          {form ? (
            <>
              <div style={fieldStyle}>
                <label style={fieldLabelStyle} htmlFor="sshsync-label">
                  Name
                </label>
                <input
                  id="sshsync-label"
                  style={inputStyle}
                  value={form.label}
                  placeholder="Production"
                  onChange={(e) => updateForm({ label: e.target.value })}
                />
              </div>

              <div style={fieldStyle}>
                <label style={fieldLabelStyle} htmlFor="sshsync-connection">
                  Connection
                </label>
                {/* A native select: FlySelect positions its menu with position:fixed,
                    which this drawer's transform shifts off-screen, and it has no
                    keyboard search for the dozens of hosts a ~/.ssh/config can hold. */}
                <select
                  id="sshsync-connection"
                  style={inputStyle}
                  value={form.connection}
                  onChange={(e) => updateForm({ connection: e.target.value })}
                >
                  {Object.entries(connectionOptions).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <span style={hintStyle}>
                  Pick a host from your ~/.ssh/config, or enter the server details.
                </span>
              </div>

              {form.connection === MANUAL_CONNECTION && (
                <div style={{ display: 'flex', gap: '10px', ...fieldStyle }}>
                  <div style={{ flex: 3 }}>
                    <label style={fieldLabelStyle} htmlFor="sshsync-host">
                      Host
                    </label>
                    <input
                      id="sshsync-host"
                      style={monoInputStyle}
                      value={form.sshHost}
                      placeholder="example.com"
                      spellCheck={false}
                      onChange={(e) => updateForm({ sshHost: e.target.value })}
                    />
                  </div>
                  <div style={{ flex: 2 }}>
                    <label style={fieldLabelStyle} htmlFor="sshsync-user">
                      User
                    </label>
                    <input
                      id="sshsync-user"
                      style={monoInputStyle}
                      value={form.sshUser}
                      spellCheck={false}
                      onChange={(e) => updateForm({ sshUser: e.target.value })}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={fieldLabelStyle} htmlFor="sshsync-port">
                      Port
                    </label>
                    <input
                      id="sshsync-port"
                      style={monoInputStyle}
                      value={form.sshPort}
                      inputMode="numeric"
                      onChange={(e) => updateForm({ sshPort: e.target.value })}
                    />
                  </div>
                </div>
              )}

              <div style={fieldStyle}>
                <span style={fieldLabelStyle}>Authentication</span>
                <label
                  style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}
                >
                  <input
                    type="radio"
                    name="sshsync-auth"
                    checked={form.auth === 'key'}
                    onChange={() => updateForm({ auth: 'key' })}
                  />{' '}
                  SSH key (your SSH agent or ~/.ssh/config)
                </label>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    fontSize: '13px',
                    marginTop: '6px',
                  }}
                >
                  <input
                    type="radio"
                    name="sshsync-auth"
                    checked={form.auth === 'password'}
                    onChange={() => updateForm({ auth: 'password' })}
                  />{' '}
                  Password
                </label>
                {form.auth === 'password' && (
                  <div style={{ marginTop: '10px' }}>
                    <input
                      id="sshsync-password"
                      type="password"
                      autoComplete="off"
                      style={inputStyle}
                      value={form.password}
                      placeholder={
                        form.hasPassword ? 'Saved (leave empty to keep it)' : 'SSH password'
                      }
                      onChange={(e) => updateForm({ password: e.target.value })}
                    />
                    <span style={hintStyle}>
                      Stored encrypted in your system keychain. A key is safer when the server
                      allows it.
                    </span>
                  </div>
                )}
              </div>

              <div style={fieldStyle}>
                <label style={fieldLabelStyle} htmlFor="sshsync-path">
                  WordPress folder
                </label>
                <input
                  id="sshsync-path"
                  style={monoInputStyle}
                  value={form.remotePath}
                  placeholder="/var/www/example.com"
                  spellCheck={false}
                  onChange={(e) => updateForm({ remotePath: e.target.value })}
                />
                <span style={hintStyle}>
                  Where wp-config.php lives: an absolute path, or ~/... from the SSH user&apos;s
                  home.
                </span>
              </div>

              <div style={fieldStyle}>
                <label style={fieldLabelStyle} htmlFor="sshsync-url">
                  Site URL
                </label>
                <input
                  id="sshsync-url"
                  style={monoInputStyle}
                  value={form.remoteUrl}
                  placeholder="https://example.com"
                  spellCheck={false}
                  onChange={(e) => updateForm({ remoteUrl: e.target.value })}
                />
              </div>

              <div style={fieldStyle}>
                <label style={fieldLabelStyle} htmlFor="sshsync-wp">
                  WP-CLI command
                </label>
                <input
                  id="sshsync-wp"
                  style={monoInputStyle}
                  value={form.wpCommand}
                  placeholder="wp"
                  spellCheck={false}
                  onChange={(e) => updateForm({ wpCommand: e.target.value })}
                />
                <span style={hintStyle}>
                  How WP-CLI runs on the server, e.g. wp or php ~/wp-cli.phar
                </span>
              </div>

              <div style={fieldStyle}>
                <label style={fieldLabelStyle} htmlFor="sshsync-cache">
                  Cache command after push (optional)
                </label>
                <input
                  id="sshsync-cache"
                  style={monoInputStyle}
                  value={form.cacheCommand}
                  placeholder="wp cache flush"
                  spellCheck={false}
                  onChange={(e) => updateForm({ cacheCommand: e.target.value })}
                />
              </div>

              <div style={fieldStyle}>
                <label style={fieldLabelStyle} htmlFor="sshsync-excludes">
                  Extra excludes (optional)
                </label>
                <textarea
                  id="sshsync-excludes"
                  style={{ ...monoInputStyle, minHeight: '64px', resize: 'vertical' }}
                  value={form.extraExcludes}
                  placeholder={'wp-content/litespeed/\nwp-content/wflogs/'}
                  spellCheck={false}
                  onChange={(e) => updateForm({ extraExcludes: e.target.value })}
                />
                <span style={hintStyle}>One rsync pattern per line, never synced either way.</span>
              </div>

              <div style={fieldStyle}>
                {/* local-components Checkbox calls onChange with the new boolean */}
                <Checkbox
                  label="This is production"
                  checked={form.isProduction}
                  onChange={(checked: boolean) => updateForm({ isProduction: checked })}
                />
                <span style={hintStyle}>
                  Database pushes to production need Migration mode and the domain typed to confirm.
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <TextButton
                  onClick={handleTestConnection}
                  disabled={testState?.status === 'busy'}
                  style={{ paddingLeft: 0 }}
                >
                  Test connection
                </TextButton>
                {testState?.status === 'busy' && <Spinner />}
                {testState?.status === 'ok' && (
                  <span style={{ color: STATUS.success, fontSize: '13px' }}>
                    ✓ Connected · WordPress at <code>{testState.remoteRoot}</code>
                  </span>
                )}
              </div>
              {testState?.status === 'error' && errorBox(testState.error)}
              {error && errorBox(error)}
            </>
          ) : (
            <>
              {environments.map((env) => (
                <div
                  key={env.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px',
                    padding: '14px 16px',
                    marginBottom: '10px',
                    backgroundColor: '#1e1e1e',
                    borderRadius: '8px',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, display: 'flex', gap: '8px' }}>
                      {env.label}
                      {env.isProduction && (
                        <span style={{ fontSize: '11px', color: STATUS.danger }}>PRODUCTION</span>
                      )}
                    </div>
                    <div style={{ fontSize: '12px', opacity: 0.65, marginTop: '2px' }}>
                      {remoteDomainOf(env.remoteUrl)} · {environmentTarget(env)}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                    <TextButton onClick={() => setForm(formFromEnvironment(env))}>Edit</TextButton>
                    <TextButton
                      onClick={() => handleRemove(env.id)}
                      disabled={isSaving}
                      style={confirmRemoveId === env.id ? { color: STATUS.danger } : undefined}
                    >
                      {confirmRemoveId === env.id ? 'Confirm remove' : 'Remove'}
                    </TextButton>
                  </div>
                </div>
              ))}
              {error && errorBox(error)}
            </>
          )}
        </div>

        <div style={footerStyle}>
          {form ? (
            <>
              <TextButton
                onClick={() => (environments.length === 0 ? handleClose() : setForm(null))}
                disabled={isSaving}
              >
                Cancel
              </TextButton>
              <PrimaryButton onClick={handleSaveForm} disabled={isSaving}>
                {isSaving ? 'Saving…' : 'Save'}
              </PrimaryButton>
            </>
          ) : (
            <>
              <TextButton onClick={handleClose}>Close</TextButton>
              <PrimaryButton onClick={() => setForm(newForm(environments.length === 0))}>
                Add environment
              </PrimaryButton>
            </>
          )}
        </div>
      </div>
    </>
  );
};

export default EnvironmentsDrawer;
