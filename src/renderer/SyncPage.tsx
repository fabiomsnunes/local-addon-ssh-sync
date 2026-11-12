import * as React from 'react';
import { useState, useEffect } from 'react';
import { Title, PrimaryButton, TextButton } from './localComponents';
import { dispatchSyncAction } from './DrawerHost';
import SyncIcon from './SyncIcon';
import { environmentTarget, remoteDomainOf, sshCommandFor } from './pushHelpers';
import { STATUS, tint } from './colors';
import { ServerEnvironment, SiteProfile } from './types';

const { ipcRenderer, shell } = window.require('electron');

interface Props {
  site: any;
  siteStatus?: string;
}

const cardStyle: React.CSSProperties = {
  backgroundColor: 'rgba(255, 255, 255, 0.03)',
  border: '1px solid rgba(255, 255, 255, 0.08)',
  borderRadius: '8px',
  padding: '4px 20px',
  marginBottom: '24px',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '14px 0',
  borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
  fontSize: '14px',
};

const lastRowStyle: React.CSSProperties = { ...rowStyle, borderBottom: 'none' };

const labelStyle: React.CSSProperties = {
  opacity: 0.6,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: '13px',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  opacity: 0.5,
  margin: '0 0 10px 2px',
};

const smallButtonStyle: React.CSSProperties = {
  background: 'none',
  border: '1px solid rgba(255, 255, 255, 0.15)',
  borderRadius: '14px',
  color: 'inherit',
  fontSize: '12px',
  padding: '4px 12px',
  cursor: 'pointer',
  fontFamily: 'inherit',
  opacity: 0.85,
};

function formatTimestamp(ts?: string): string {
  if (!ts) return 'Never';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return 'Never';
  }
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

const productionBadgeStyle: React.CSSProperties = {
  fontSize: '10px',
  fontWeight: 700,
  letterSpacing: '0.5px',
  color: STATUS.danger,
  backgroundColor: tint(STATUS.danger, 0.12),
  borderRadius: '4px',
  padding: '2px 6px',
};

// The add-on's home: a dedicated page under the site's More tab
// (per build.localwp.com "Giving your add-on a home" — new tabs live as
// dropdown items under More, with the add-on name in the title bar).
const SyncPage: React.FC<Props> = ({ site }) => {
  const [profile, setProfile] = useState<SiteProfile | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [copiedEnvId, setCopiedEnvId] = useState<string | null>(null);
  const [cli, setCli] = useState<{ installed: boolean; path: string; error?: string } | null>(null);

  useEffect(() => {
    ipcRenderer.invoke('sshsync:cliStatus').then(setCli);
  }, []);

  const installCli = async () => {
    const result = await ipcRenderer.invoke('sshsync:installCli');
    setCli(
      result.success
        ? { installed: true, path: result.path }
        : { installed: false, path: cli?.path || '', error: result.error },
    );
  };

  const refresh = async () => {
    const stored: SiteProfile | null =
      (await ipcRenderer.invoke('sshsync:getProfile', site.id)) ?? null;
    setProfile(stored);
    setLoaded(true);
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh() only reads site.id; re-run on site change
  }, [site.id]);

  // DrawerHost dispatches this after saving environments or a sync
  useEffect(() => {
    const handler = (e: Event) => {
      const { siteId } = (e as CustomEvent).detail || {};
      if (!siteId || siteId === site.id) refresh();
    };
    window.addEventListener('sshsync:state-changed', handler);
    return () => window.removeEventListener('sshsync:state-changed', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribe once per site; handler reads the current site.id closure
  }, [site.id]);

  const handleCopySsh = (env: ServerEnvironment) => {
    navigator.clipboard.writeText(sshCommandFor(env));
    setCopiedEnvId(env.id);
    setTimeout(() => setCopiedEnvId(null), 2000);
  };

  if (!loaded) return null;

  const environments = profile?.environments || [];

  return (
    // Local pages own their scrolling — without this the content clips
    // behind the bottom bar (Live Link / Pull / Push)
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ padding: '20px 30px 48px', maxWidth: '760px' }}>
        {/* Title bar — docs require the add-on name here */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            margin: '20px 0',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <SyncIcon size={36} />
            <Title size="l" style={{ margin: 0 }}>
              SSH Sync
            </Title>
          </div>
          {environments.length > 0 && (
            <TextButton onClick={() => dispatchSyncAction('environments', site.id)}>
              Edit environments
            </TextButton>
          )}
        </div>

        {environments.length === 0 ? (
          <>
            <p
              style={{
                opacity: 0.7,
                fontSize: '14px',
                lineHeight: 1.6,
                marginBottom: '24px',
                maxWidth: '520px',
              }}
            >
              Add the server where {site.name || 'this site'} lives to pull its files and database
              into Local, and push your changes back, over SSH.
            </p>
            <PrimaryButton onClick={() => dispatchSyncAction('environments', site.id)}>
              Add a server
            </PrimaryButton>
          </>
        ) : (
          <>
            {/* Environments */}
            <div style={sectionTitleStyle}>Environments</div>
            <div style={cardStyle}>
              {environments.map((env, idx) => (
                <div
                  key={env.id}
                  style={{
                    ...(idx === environments.length - 1 ? lastRowStyle : rowStyle),
                    gap: '16px',
                  }}
                >
                  <div
                    style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontWeight: 600 }}>{env.label}</span>
                      {env.isProduction && <span style={productionBadgeStyle}>PRODUCTION</span>}
                    </span>
                    <span style={{ fontSize: '12px', opacity: 0.6 }}>
                      {remoteDomainOf(env.remoteUrl)} · {environmentTarget(env)}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                    <button
                      style={smallButtonStyle}
                      onClick={() => dispatchSyncAction('pull', site.id, env.id)}
                    >
                      ⬇ Pull
                    </button>
                    <button
                      style={smallButtonStyle}
                      onClick={() => dispatchSyncAction('push', site.id, env.id)}
                    >
                      ⬆ Push
                    </button>
                    <button
                      style={smallButtonStyle}
                      onClick={() => shell.openExternal(env.remoteUrl)}
                    >
                      Open site ↗
                    </button>
                    <button style={smallButtonStyle} onClick={() => handleCopySsh(env)}>
                      {copiedEnvId === env.id ? 'Copied!' : 'Copy SSH'}
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Last syncs */}
            <div style={cardStyle}>
              <div style={rowStyle}>
                <span style={labelStyle}>Last pulled</span>
                <span>{formatTimestamp(profile?.lastPullAt)}</span>
              </div>
              <div style={lastRowStyle}>
                <span style={labelStyle}>Last pushed</span>
                <span>{formatTimestamp(profile?.lastPushAt)}</span>
              </div>
            </div>

            {/* Sync history */}
            <div style={sectionTitleStyle}>Recent syncs</div>
            <div style={cardStyle}>
              {profile?.history && profile.history.length > 0 ? (
                profile.history.map((entry, idx) => (
                  <div
                    key={`${entry.at}-${idx}`}
                    style={idx === profile.history!.length - 1 ? lastRowStyle : rowStyle}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span
                        style={{
                          color: entry.mode === 'pull' ? STATUS.success : STATUS.warning,
                          fontSize: '13px',
                        }}
                      >
                        {entry.mode === 'pull' ? '⬇ Pull' : '⬆ Push'}
                      </span>
                      <span style={{ opacity: 0.6, fontSize: '13px' }}>
                        {entry.environmentLabel}
                      </span>
                    </span>
                    <span style={{ opacity: 0.6, fontSize: '13px' }}>
                      {formatTimestamp(entry.at)} · {formatDuration(entry.durationMs)}
                    </span>
                  </div>
                ))
              ) : (
                <div style={{ ...lastRowStyle, opacity: 0.5 }}>No syncs yet</div>
              )}
            </div>

            {/* Command line */}
            <div style={sectionTitleStyle}>Command line</div>
            <div style={cardStyle}>
              <div style={lastRowStyle}>
                <span style={{ fontSize: '13px', opacity: 0.8 }}>
                  {cli?.installed ? (
                    <>
                      <code>ssh-sync pull {site.name} &lt;environment&gt;</code> from any terminal
                      where Local&apos;s <code>localwp</code> works.
                    </>
                  ) : (
                    'Pull and push from the terminal with the ssh-sync command.'
                  )}
                  {cli?.error && (
                    <span style={{ display: 'block', color: STATUS.danger }}>{cli.error}</span>
                  )}
                </span>
                {!cli?.installed && (
                  <button style={smallButtonStyle} onClick={installCli}>
                    Install ssh-sync
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default SyncPage;
