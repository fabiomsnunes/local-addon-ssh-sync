import * as React from 'react';
import { useState, useEffect } from 'react';
import { Title, PrimaryButton, TextButton, Spinner } from './localComponents';
import { dispatchKinstaAction } from './KinstaSitePanel';
import KinstaIcon from './KinstaIcon';
import { envLabel } from './pushHelpers';
import { STATUS } from './colors';
import { Environment } from './types';

const { ipcRenderer, shell } = window.require('electron');

interface SyncHistoryEntry {
  mode: 'pull' | 'push';
  envType: string;
  at: string;
  durationMs: number;
}

interface SiteLink {
  localSiteId: string;
  kinstaSiteId: string;
  kinstaSiteName: string;
  kinstaSiteSlug?: string;
  lastPullAt?: string;
  lastPushAt?: string;
  history?: SyncHistoryEntry[];
}

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

function envDomain(env: Environment): string {
  return env.primaryDomain?.name || env.domains?.[0]?.name || env.display_name;
}

// Same SSH username derivation as the sync drawer
function sshUserFromSlug(link: SiteLink): string {
  const siteName = link.kinstaSiteSlug || link.kinstaSiteName;
  return siteName.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// The add-on's home: a dedicated page under the site's More tab
// (per build.localwp.com "Giving your add-on a home" — new tabs live as
// dropdown items under More, with the add-on name in the title bar).
const KinstaPage: React.FC<Props> = ({ site }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [link, setLink] = useState<SiteLink | null>(null);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Per-environment transient button states
  const [cacheState, setCacheState] = useState<Record<string, 'busy' | 'done' | 'error'>>({});
  const [copiedEnvId, setCopiedEnvId] = useState<string | null>(null);

  const refresh = async () => {
    const config = await ipcRenderer.invoke('kinsta:getConfig');
    setIsConnected(!!config.apiKey);
    setCompanyId(config.companyId || null);
    const siteLink: SiteLink | null =
      (await ipcRenderer.invoke('kinsta:getSiteLink', site.id)) ?? null;
    setLink(siteLink);
    setLoaded(true);

    if (siteLink) {
      const result = await ipcRenderer.invoke('kinsta:getEnvironments', siteLink.kinstaSiteId);
      if (result.success) {
        // Production first
        const envs = [...result.environments].sort(
          (a: Environment, b: Environment) => Number(b.is_premium) - Number(a.is_premium),
        );
        setEnvironments(envs);
      }
    } else {
      setEnvironments([]);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh() only reads site.id; re-run on site change
  }, [site.id]);

  // KinstaDrawerHost dispatches this after link/unlink/sync so the page stays fresh
  useEffect(() => {
    const handler = (e: Event) => {
      const { siteId } = (e as CustomEvent).detail || {};
      if (!siteId || siteId === site.id) refresh();
    };
    window.addEventListener('kinsta:state-changed', handler);
    return () => window.removeEventListener('kinsta:state-changed', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribe once per site; handler reads the current site.id closure
  }, [site.id]);

  const handleClearCache = async (env: Environment) => {
    setCacheState((s) => ({ ...s, [env.id]: 'busy' }));
    const result = await ipcRenderer.invoke('kinsta:clearCache', env.id, env.cdn_cache_id);
    setCacheState((s) => ({ ...s, [env.id]: result.success ? 'done' : 'error' }));
    setTimeout(() => {
      setCacheState((s) => {
        const next = { ...s };
        delete next[env.id];
        return next;
      });
    }, 2500);
  };

  // Deep link to the site's MyKinsta dashboard:
  // /sites/details/<siteId>/<envId>?idCompany=<companyId>
  const openMyKinsta = () => {
    if (link && companyId && environments.length > 0) {
      shell.openExternal(
        `https://my.kinsta.com/sites/details/${link.kinstaSiteId}/${environments[0].id}?idCompany=${companyId}`,
      );
    } else {
      shell.openExternal('https://my.kinsta.com/sites');
    }
  };

  const handleCopySsh = (env: Environment) => {
    if (!link) return;
    const host = env.ssh_connection?.ssh_ip?.external_ip || '';
    const port = env.ssh_connection?.ssh_port || '22';
    navigator.clipboard.writeText(`ssh ${sshUserFromSlug(link)}@${host} -p ${port}`);
    setCopiedEnvId(env.id);
    setTimeout(() => setCopiedEnvId(null), 2000);
  };

  if (!loaded) return null;

  return (
    // Local pages own their scrolling — without this the content clips
    // behind the bottom bar (Live Link / Pull / Push)
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ padding: '20px 30px 48px', maxWidth: '720px' }}>
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
            <KinstaIcon size={36} />
            <Title size="l" style={{ margin: 0 }}>
              Kinsta Sync
            </Title>
          </div>
          <TextButton onClick={openMyKinsta}>Open MyKinsta ↗</TextButton>
        </div>

        {isConnected && link ? (
          <>
            {/* Link status */}
            <div style={cardStyle}>
              <div style={rowStyle}>
                <span style={labelStyle}>Linked site</span>
                <span style={{ fontWeight: 600 }}>{link.kinstaSiteName}</span>
              </div>
              <div style={rowStyle}>
                <span style={labelStyle}>Last pulled</span>
                <span>{formatTimestamp(link.lastPullAt)}</span>
              </div>
              <div style={lastRowStyle}>
                <span style={labelStyle}>Last pushed</span>
                <span>{formatTimestamp(link.lastPushAt)}</span>
              </div>
            </div>

            {/* Sync actions — open the existing drawers via KinstaDrawerHost */}
            <div style={{ display: 'flex', gap: '12px', marginBottom: '28px' }}>
              <PrimaryButton onClick={() => dispatchKinstaAction('pull', site.id)}>
                Pull from Kinsta
              </PrimaryButton>
              <PrimaryButton onClick={() => dispatchKinstaAction('push', site.id)}>
                Push to Kinsta
              </PrimaryButton>
            </div>

            {/* Environments */}
            <div style={sectionTitleStyle}>Environments</div>
            <div style={cardStyle}>
              {environments.length === 0 ? (
                <div
                  style={{ padding: '16px 0', display: 'flex', alignItems: 'center', gap: '10px' }}
                >
                  <Spinner />
                  <span style={{ opacity: 0.6, fontSize: '13px' }}>Loading environments...</span>
                </div>
              ) : (
                environments.map((env, idx) => (
                  <div
                    key={env.id}
                    style={idx === environments.length - 1 ? lastRowStyle : rowStyle}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ fontWeight: 600 }}>{envLabel(env)}</span>
                      <span style={{ fontSize: '12px', opacity: 0.6 }}>{envDomain(env)}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        style={smallButtonStyle}
                        onClick={() => shell.openExternal(`https://${envDomain(env)}`)}
                      >
                        Open site ↗
                      </button>
                      <button style={smallButtonStyle} onClick={() => handleCopySsh(env)}>
                        {copiedEnvId === env.id ? 'Copied!' : 'Copy SSH'}
                      </button>
                      <button
                        style={{
                          ...smallButtonStyle,
                          ...(cacheState[env.id] === 'done'
                            ? { borderColor: STATUS.success, color: STATUS.success }
                            : {}),
                          ...(cacheState[env.id] === 'error'
                            ? { borderColor: STATUS.danger, color: STATUS.danger }
                            : {}),
                        }}
                        onClick={() => handleClearCache(env)}
                        disabled={cacheState[env.id] === 'busy'}
                      >
                        {cacheState[env.id] === 'busy'
                          ? 'Clearing...'
                          : cacheState[env.id] === 'done'
                            ? 'Cache cleared ✓'
                            : cacheState[env.id] === 'error'
                              ? 'Failed'
                              : 'Clear cache'}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Sync history */}
            <div style={sectionTitleStyle}>Recent syncs</div>
            <div style={cardStyle}>
              {link.history && link.history.length > 0 ? (
                link.history.map((entry, idx) => (
                  <div
                    key={`${entry.at}-${idx}`}
                    style={idx === link.history!.length - 1 ? lastRowStyle : rowStyle}
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
                        {entry.envType === 'live' ? 'Production' : 'Staging'}
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

            {/* Secondary actions */}
            <div
              style={{
                paddingTop: '16px',
                borderTop: '1px solid rgba(255, 255, 255, 0.06)',
              }}
            >
              <TextButton
                onClick={() => dispatchKinstaAction('unlink', site.id)}
                style={{ opacity: 0.7 }}
              >
                Unlink from Kinsta
              </TextButton>
            </div>
          </>
        ) : (
          <>
            {/* Not linked yet */}
            <p
              style={{
                opacity: 0.7,
                fontSize: '14px',
                lineHeight: 1.6,
                marginBottom: '24px',
                maxWidth: '480px',
              }}
            >
              {isConnected
                ? `Link ${site.name || 'this site'} to a Kinsta site to pull and push files and database between Local and Kinsta.`
                : 'Connect your Kinsta account and link this site to pull and push files and database between Local and Kinsta.'}
            </p>
            <PrimaryButton onClick={() => dispatchKinstaAction('link', site.id)}>
              Link to Kinsta
            </PrimaryButton>
          </>
        )}
      </div>
    </div>
  );
};

export default KinstaPage;
