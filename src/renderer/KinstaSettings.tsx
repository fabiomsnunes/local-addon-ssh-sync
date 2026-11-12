import * as React from 'react';
import { useState, useEffect } from 'react';

const { ipcRenderer } = window.require('electron');

const KinstaSettings: React.FC = () => {
  const [apiKey, setApiKey] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    loadConfig();
  }, []);

  // Local's own account page ("Connected accounts") removes the whole Apply
  // footer via an internal noApply flag that isn't exposed to add-on settings
  // sections. Replicate it: hide the footer (button + divider) while our
  // section is mounted — the style is removed on unmount, so other preference
  // pages keep their Apply. Substring match survives CSS Modules hash changes.
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = '[class*="SettingsPane_Footer"] { display: none; }';
    document.head.appendChild(style);
    return () => {
      document.head.removeChild(style);
    };
  }, []);

  const loadConfig = async () => {
    const config = await ipcRenderer.invoke('kinsta:getConfig');
    if (config.apiKey) {
      setApiKey('••••••••••••••••');
      setCompanyId(config.companyId || '');
      setIsConnected(true);
    }
  };

  const handleConnect = async () => {
    if (!apiKey || apiKey.startsWith('••')) {
      setError('Please enter a valid API key');
      return;
    }
    if (!companyId) {
      setError('Please enter your Company ID');
      return;
    }

    setIsConnecting(true);
    setError(null);
    setSuccess(null);

    const result = await ipcRenderer.invoke('kinsta:testConnection', apiKey, companyId);

    if (result.success) {
      setIsConnected(true);
      setApiKey('••••••••••••••••');
      setSuccess('Connected to Kinsta!');
    } else {
      setError(result.error || 'Could not connect to Kinsta');
    }

    setIsConnecting(false);
  };

  const handleDisconnect = async () => {
    await ipcRenderer.invoke('kinsta:disconnect');
    setIsConnected(false);
    setApiKey('');
    setCompanyId('');
    setSuccess(null);
    setConfirmDisconnect(false);
  };

  const handleCopyId = () => {
    navigator.clipboard.writeText(companyId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const containerStyle: React.CSSProperties = {
    padding: '20px',
    maxWidth: '520px',
    color: '#fff',
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px',
    marginBottom: '10px',
    borderRadius: '4px',
    border: '1px solid #444',
    backgroundColor: '#2d2d2d',
    color: '#fff',
    fontSize: '14px',
  };

  const buttonStyle: React.CSSProperties = {
    padding: '10px 20px',
    borderRadius: '4px',
    border: 'none',
    cursor: 'pointer',
    fontWeight: 500,
    backgroundColor: '#51cf66',
    color: '#000',
    marginRight: '10px',
  };

  const subtleButtonStyle: React.CSSProperties = {
    background: 'none',
    border: '1px solid rgba(255, 255, 255, 0.2)',
    borderRadius: '14px',
    color: 'inherit',
    fontSize: '12px',
    padding: '4px 12px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  };

  const infoRowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 0',
    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
    fontSize: '14px',
  };

  return (
    <div style={containerStyle}>
      <h2 style={{ marginBottom: '20px' }}>Kinsta Sync</h2>

      <div
        style={{
          padding: '10px 15px',
          backgroundColor: isConnected ? 'rgba(81, 207, 102, 0.2)' : 'rgba(255,255,255,0.1)',
          borderRadius: '4px',
          marginBottom: '20px',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
        }}
      >
        <span
          style={{
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            backgroundColor: isConnected ? '#51cf66' : '#666',
          }}
        />
        {isConnected ? 'Connected to Kinsta' : 'Not connected'}
      </div>

      {error && (
        <div
          style={{
            padding: '10px',
            backgroundColor: 'rgba(255,107,107,0.2)',
            borderRadius: '4px',
            marginBottom: '15px',
            color: '#ff6b6b',
          }}
        >
          {error}
        </div>
      )}

      {success && (
        <div
          style={{
            padding: '10px',
            backgroundColor: 'rgba(81,207,102,0.2)',
            borderRadius: '4px',
            marginBottom: '15px',
            color: '#51cf66',
          }}
        >
          {success}
        </div>
      )}

      {!isConnected ? (
        <>
          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px' }}>API Key</label>
            <input
              type="password"
              style={inputStyle}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Enter your Kinsta API key"
            />
            <small style={{ color: '#888' }}>
              Create at{' '}
              <a
                href="https://my.kinsta.com/account/api-keys"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: '#51cf66' }}
              >
                MyKinsta
              </a>{' '}
              — consider setting an expiry and rotating it yearly
            </small>
          </div>

          <div style={{ marginBottom: '20px' }}>
            <label style={{ display: 'block', marginBottom: '5px' }}>Company ID</label>
            <input
              type="text"
              style={inputStyle}
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
              placeholder="e.g. abc123def456"
            />
            <small style={{ color: '#888' }}>
              Found in your MyKinsta URL (?idCompany=...) or under Company settings → Billing
              details
            </small>
          </div>

          <button style={buttonStyle} onClick={handleConnect} disabled={isConnecting}>
            {isConnecting ? 'Connecting...' : 'Connect to Kinsta'}
          </button>
        </>
      ) : (
        <>
          {/* Read-only account info — not a form */}
          <div
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: '8px',
              padding: '4px 16px',
              marginBottom: '24px',
            }}
          >
            <div style={infoRowStyle}>
              <span style={{ opacity: 0.6 }}>API key</span>
              {/* Constant mask — never render the apiKey state here (it briefly holds the raw key during connect) */}
              <span
                style={{
                  fontFamily: 'monospace',
                  fontSize: '12px',
                  opacity: 0.8,
                  letterSpacing: '2px',
                }}
              >
                {'••••••••••••••••'}
              </span>
            </div>
            <div style={{ ...infoRowStyle, borderBottom: 'none' }}>
              <span style={{ opacity: 0.6 }}>Company ID</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontFamily: 'monospace', fontSize: '12px', opacity: 0.8 }}>
                  {companyId}
                </span>
                <button style={subtleButtonStyle} onClick={handleCopyId}>
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </span>
            </div>
          </div>

          <p style={{ fontSize: '13px', color: '#888', marginBottom: '16px' }}>
            Link sites to Kinsta from each site's <strong>More → Kinsta Sync</strong> page.
          </p>

          {!confirmDisconnect ? (
            <button
              style={{
                ...subtleButtonStyle,
                borderColor: 'rgba(255, 107, 107, 0.5)',
                color: '#ff6b6b',
                padding: '8px 16px',
                fontSize: '13px',
              }}
              onClick={() => setConfirmDisconnect(true)}
            >
              Disconnect from Kinsta...
            </button>
          ) : (
            <div
              style={{
                padding: '16px',
                backgroundColor: 'rgba(255, 107, 107, 0.08)',
                border: '1px solid rgba(255, 107, 107, 0.3)',
                borderRadius: '8px',
              }}
            >
              <p style={{ fontSize: '13px', marginBottom: '6px' }}>
                Disconnect from Kinsta? The API key will be deleted from this machine.
              </p>
              <p style={{ fontSize: '12px', color: '#888', marginBottom: '14px' }}>
                Your site links are kept and will work again after reconnecting.
              </p>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  style={{
                    ...buttonStyle,
                    backgroundColor: '#ff6b6b',
                    color: '#fff',
                    marginRight: 0,
                  }}
                  onClick={handleDisconnect}
                >
                  Yes, disconnect
                </button>
                <button
                  style={{ ...subtleButtonStyle, padding: '10px 16px', fontSize: '13px' }}
                  onClick={() => setConfirmDisconnect(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default KinstaSettings;
