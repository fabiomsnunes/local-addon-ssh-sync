import * as React from 'react';
import { useState, useEffect, useMemo, useRef } from 'react';
import { PrimaryButton, TextButton, Spinner, Title, InputSearch } from './localComponents';
import KinstaIcon from './KinstaIcon';
import { STATUS, tint } from './colors';

const { ipcRenderer } = window.require('electron');

interface SiteLink {
  localSiteId: string;
  kinstaSiteId: string;
  kinstaSiteName: string;
  kinstaSiteSlug?: string;
}

interface KinstaSite {
  id: string;
  name: string;
  display_name: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onLinkComplete: (link: SiteLink) => void;
  // Shortcut from the success view straight into the pull drawer
  onStartPull?: () => void;
  site: any;
  isConnected: boolean;
}

const KinstaLinkDrawer: React.FC<Props> = ({
  isOpen,
  onClose,
  onLinkComplete,
  onStartPull,
  site,
  isConnected,
}) => {
  const [apiKey, setApiKey] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [connected, setConnected] = useState(isConnected);
  const [kinstaSites, setKinstaSites] = useState<KinstaSite[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState<string>('');
  const [isLinking, setIsLinking] = useState(false);
  const [isLoadingSites, setIsLoadingSites] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [linkedSite, setLinkedSite] = useState<SiteLink | null>(null);
  const searchWrapRef = useRef<HTMLDivElement>(null);

  // Autofocus the search field once the site list is shown.
  // InputSearch doesn't forward refs, so focus the inner <input> via a wrapper.
  // Small delay lets the drawer's slide-in transition finish first.
  useEffect(() => {
    if (isOpen && connected && !isLoadingSites && kinstaSites.length > 0) {
      const timer = setTimeout(() => {
        searchWrapRef.current?.querySelector('input')?.focus();
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [isOpen, connected, isLoadingSites, kinstaSites.length]);

  // Sync connected state with prop
  useEffect(() => {
    setConnected(isConnected);
  }, [isConnected]);

  // Load sites when drawer opens and connected
  useEffect(() => {
    if (isOpen && connected) {
      loadKinstaSites();
    }
  }, [isOpen, connected]);

  // Reset transient state when drawer closes
  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setLinkedSite(null);
      setError(null);
    }
  }, [isOpen]);

  const loadKinstaSites = async () => {
    setIsLoadingSites(true);
    setError(null);
    const result = await ipcRenderer.invoke('kinsta:getSites');
    if (result.success) {
      setKinstaSites(result.sites);
    } else {
      setError(result.error);
    }
    setIsLoadingSites(false);
  };

  // Filter and sort sites
  const filteredSites = useMemo(() => {
    let sites = [...kinstaSites];

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      sites = sites.filter(
        (s) =>
          (s.display_name || s.name).toLowerCase().includes(query) ||
          s.name.toLowerCase().includes(query),
      );
    }

    // Sort alphabetically by display name
    sites.sort((a, b) => {
      const nameA = (a.display_name || a.name).toLowerCase();
      const nameB = (b.display_name || b.name).toLowerCase();
      return nameA.localeCompare(nameB);
    });

    return sites;
  }, [kinstaSites, searchQuery]);

  const handleConnect = async () => {
    if (!apiKey || !companyId) {
      setError('Please enter both API Key and Company ID');
      return;
    }

    setIsConnecting(true);
    setError(null);

    const result = await ipcRenderer.invoke('kinsta:testConnection', apiKey, companyId);
    if (result.success) {
      setConnected(true);
      loadKinstaSites();
    } else {
      setError(result.error || 'Could not connect to Kinsta');
    }
    setIsConnecting(false);
  };

  const handleLink = async () => {
    if (!selectedSiteId) {
      setError('Please select a Kinsta site');
      return;
    }

    setIsLinking(true);
    setError(null);

    const kinstaSite = kinstaSites.find((s) => s.id === selectedSiteId);
    const result = await ipcRenderer.invoke('kinsta:linkSite', site.id, kinstaSite);

    if (result.success) {
      onLinkComplete(result.link);
      // Stay open and show the success view instead of silently closing
      setLinkedSite(result.link);
    } else {
      setError(result.error);
    }
    setIsLinking(false);
  };

  // Drawer styles
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
    width: '420px',
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
    padding: '20px 24px',
    borderTop: '1px solid #3e3e3e',
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '12px 16px',
    backgroundColor: '#1e1e1e',
    border: '1px solid #3e3e3e',
    borderRadius: '4px',
    color: '#fff',
    fontSize: '14px',
    outline: 'none',
    marginBottom: '16px',
    boxSizing: 'border-box',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    marginBottom: '8px',
    fontSize: '13px',
    fontWeight: 500,
  };

  return (
    <>
      <div style={overlayStyle} onClick={onClose} />

      <div style={drawerStyle}>
        {/* Header */}
        <div style={headerStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <KinstaIcon size={28} />
            <Title size="s" style={{ margin: 0 }}>
              {connected ? 'Link to Kinsta' : 'Connect to Kinsta'}
            </Title>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '8px',
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

        {/* Content */}
        <div style={contentStyle}>
          {linkedSite ? (
            /* Success state — mirrors the sync drawer's complete view */
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                textAlign: 'center',
              }}
            >
              <div
                style={{
                  width: '80px',
                  height: '80px',
                  borderRadius: '50%',
                  backgroundColor: tint(STATUS.success, 0.15),
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: '24px',
                }}
              >
                <svg
                  width="40"
                  height="40"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={STATUS.success}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <Title size="m" style={{ marginBottom: '8px', color: STATUS.success }}>
                Site Linked!
              </Title>
              <span style={{ opacity: 0.7, display: 'block', marginBottom: '8px' }}>
                <strong>{site.name || site.domain}</strong> is now linked to{' '}
                <strong>{linkedSite.kinstaSiteName}</strong>.
              </span>
              <span style={{ opacity: 0.5, fontSize: '13px' }}>
                Pull to fetch files and database from Kinsta, or find all actions in the site's More
                menu.
              </span>
            </div>
          ) : !connected ? (
            <>
              {/* Connect Form */}
              <p style={{ color: '#888', fontSize: '14px', marginBottom: '24px', lineHeight: 1.5 }}>
                Enter your Kinsta API credentials to connect. You can create an API key in your{' '}
                <a
                  href="https://my.kinsta.com/account/api-keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: STATUS.linked }}
                >
                  MyKinsta dashboard
                </a>
                .
              </p>

              <div>
                <label style={labelStyle}>API Key</label>
                <input
                  type="password"
                  style={inputStyle}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Enter your Kinsta API key"
                />
              </div>

              <div>
                <label style={labelStyle}>Company ID</label>
                <input
                  type="text"
                  style={inputStyle}
                  value={companyId}
                  onChange={(e) => setCompanyId(e.target.value)}
                  placeholder="e.g. abc123def456"
                />
                <p style={{ color: '#666', fontSize: '12px', marginTop: '-8px' }}>
                  Find this in MyKinsta → Company → Company Details
                </p>
              </div>
            </>
          ) : (
            <>
              {/* Link Form */}
              <p style={{ color: '#888', fontSize: '14px', marginBottom: '16px', lineHeight: 1.5 }}>
                Select the Kinsta site to link with{' '}
                <strong style={{ color: '#fff' }}>{site.name}</strong>.
              </p>

              <div>
                {isLoadingSites ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      padding: '16px',
                      backgroundColor: '#1e1e1e',
                      border: '1px solid #3e3e3e',
                      borderRadius: '4px',
                    }}
                  >
                    <Spinner />
                    <span style={{ color: '#888' }}>Loading Kinsta sites...</span>
                  </div>
                ) : kinstaSites.length === 0 ? (
                  <div
                    style={{
                      padding: '16px',
                      backgroundColor: '#1e1e1e',
                      border: '1px solid #3e3e3e',
                      borderRadius: '4px',
                      color: '#888',
                    }}
                  >
                    No sites found. Make sure your API key has access to sites.
                  </div>
                ) : (
                  <>
                    {/* Search input */}
                    <div ref={searchWrapRef} style={{ marginBottom: '12px' }}>
                      <InputSearch
                        value={searchQuery}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          setSearchQuery(e.target.value)
                        }
                        placeholder={`Search ${kinstaSites.length} sites...`}
                      />
                    </div>

                    {/* Sites count */}
                    <div
                      style={{
                        fontSize: '12px',
                        color: '#666',
                        marginBottom: '8px',
                        paddingLeft: '2px',
                      }}
                    >
                      {filteredSites.length === kinstaSites.length
                        ? `${kinstaSites.length} sites`
                        : `${filteredSites.length} of ${kinstaSites.length} sites`}
                    </div>

                    {/* Sites list */}
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                        maxHeight: '400px',
                        overflowY: 'auto',
                      }}
                    >
                      {filteredSites.length === 0 ? (
                        <div
                          style={{
                            padding: '24px 16px',
                            textAlign: 'center',
                            color: '#666',
                            fontSize: '14px',
                          }}
                        >
                          No sites match "{searchQuery}"
                        </div>
                      ) : (
                        filteredSites.map((kSite) => (
                          <button
                            key={kSite.id}
                            onClick={() => setSelectedSiteId(kSite.id)}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '12px',
                              padding: '10px 12px',
                              backgroundColor:
                                selectedSiteId === kSite.id ? tint(STATUS.linked, 0.15) : '#1e1e1e',
                              border:
                                selectedSiteId === kSite.id
                                  ? `2px solid ${STATUS.linked}`
                                  : '1px solid #3e3e3e',
                              borderRadius: '8px',
                              cursor: 'pointer',
                              textAlign: 'left',
                              width: '100%',
                              transition: 'all 0.15s ease',
                            }}
                            onMouseEnter={(e) => {
                              if (selectedSiteId !== kSite.id) {
                                e.currentTarget.style.backgroundColor = '#252525';
                                e.currentTarget.style.borderColor = '#4e4e4e';
                              }
                            }}
                            onMouseLeave={(e) => {
                              if (selectedSiteId !== kSite.id) {
                                e.currentTarget.style.backgroundColor = '#1e1e1e';
                                e.currentTarget.style.borderColor = '#3e3e3e';
                              }
                            }}
                          >
                            <div
                              style={{
                                width: '36px',
                                height: '36px',
                                borderRadius: '6px',
                                overflow: 'hidden',
                                flexShrink: 0,
                              }}
                            >
                              <KinstaIcon size={36} />
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div
                                style={{
                                  color: selectedSiteId === kSite.id ? '#fff' : '#ccc',
                                  fontSize: '14px',
                                  fontWeight: 500,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {kSite.display_name || kSite.name}
                              </div>
                              <div
                                style={{
                                  color: '#666',
                                  fontSize: '12px',
                                  marginTop: '1px',
                                }}
                              >
                                {kSite.name}
                              </div>
                            </div>
                            {selectedSiteId === kSite.id && (
                              <svg
                                width="18"
                                height="18"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke={STATUS.linked}
                                strokeWidth="2.5"
                              >
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            )}
                          </button>
                        ))
                      )}
                    </div>
                  </>
                )}
              </div>
            </>
          )}

          {error && (
            <div
              style={{
                marginTop: '16px',
                padding: '12px 16px',
                backgroundColor: tint(STATUS.danger, 0.1),
                border: `1px solid ${tint(STATUS.danger, 0.3)}`,
                borderRadius: '8px',
                color: STATUS.danger,
                fontSize: '13px',
              }}
            >
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={footerStyle}>
          {linkedSite ? (
            <div style={{ display: 'flex', gap: '12px' }}>
              <TextButton onClick={onClose} style={{ flex: 1 }}>
                Close
              </TextButton>
              {onStartPull && (
                <PrimaryButton onClick={onStartPull} style={{ flex: 1 }}>
                  Pull from Kinsta
                </PrimaryButton>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', gap: '12px' }}>
              <TextButton onClick={onClose} style={{ flex: 1 }}>
                Cancel
              </TextButton>
              {!connected ? (
                <PrimaryButton
                  onClick={handleConnect}
                  disabled={isConnecting || !apiKey || !companyId}
                  style={{ flex: 1 }}
                >
                  {isConnecting ? 'Connecting...' : 'Connect'}
                </PrimaryButton>
              ) : (
                <PrimaryButton
                  onClick={handleLink}
                  disabled={isLinking || !selectedSiteId || isLoadingSites}
                  style={{ flex: 1 }}
                >
                  {isLinking ? 'Linking...' : 'Link Site'}
                </PrimaryButton>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default KinstaLinkDrawer;
