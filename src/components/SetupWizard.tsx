import { useEffect, useRef, useState, type ReactNode } from 'react';
import { describeDbError, resetClient } from '../lib/db';
import { downloadBlob } from '../lib/download';
import styles from './SetupWizard.module.css';

type Status = { ok: boolean; message: string };

interface SetupWizardProps {
  onComplete?: () => void;
  onAlreadyInstalled?: () => Promise<boolean>;
}

interface StepMeta {
  id: number;
  title: string;
  subtitle: string;
}

interface ComingSoonOption {
  id: string;
  label: string;
  hint: string;
}

interface AdminReport {
  id?: string;
  email?: string;
  role?: string | null;
  warning?: string;
}

interface EnvRow {
  key: string;
  value: string;
  client: boolean;
}

const STEPS: StepMeta[] = [
  { id: 1, title: 'Supabase', subtitle: 'Connect your Supabase project' },
  { id: 2, title: 'Site & Admin', subtitle: 'Name your site and create the administrator' },
  { id: 3, title: 'Deploy to Vercel', subtitle: 'Provision the database and launch' },
];

const OTHER_DATABASES: ComingSoonOption[] = [
  { id: 'postgres', label: 'Self-Hosted PostgreSQL', hint: 'Neon, Render, Railway or your own server.' },
  { id: 'mysql', label: 'MySQL / MariaDB', hint: 'PlanetScale, Hostinger Remote MySQL, Railway.' },
  { id: 'sqlite', label: 'SQLite (Local File)', hint: 'Embedded local .db file on a writable disk.' },
  { id: 'libsql', label: 'SQLite / Turso (LibSQL)', hint: 'Serverless HTTP-based SQLite.' },
];

const OTHER_HOSTS: ComingSoonOption[] = [
  { id: 'node', label: 'Persistent Node Server / VPS', hint: 'Docker, DigitalOcean, Render with a persistent disk.' },
  { id: 'edge', label: 'Edge (Cloudflare / Bun / Deno)', hint: 'Workers, Pages and other read-only edge runtimes.' },
];

const SUPABASE_URL_PATTERN = /^https:\/\/[a-z0-9][a-z0-9-]*\.supabase\.co\/?$/i;

const VARIABLE_GUIDE: Record<string, string> = {
  DB_TYPE: 'The database backend. Keep as supabase.',
  VITE_DB_TYPE: 'Mirror of DB_TYPE for the browser bundle.',
  DATABASE_URL: 'Server-only direct PostgreSQL connection (contains the database password). Add it to Vercel as a server variable, never prefixed with VITE_.',
  VITE_SUPABASE_URL: 'Public Supabase project URL. Safe to ship to the browser.',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'Public anon/publishable key. Safe to ship to the browser.',
  JWT_SECRET: 'Server-only secret for non-Supabase auth. Never prefixed with VITE_.',
};

const trim = (value: string): string => value.trim();

function parseEnvBlock(block: string): EnvRow[] {
  return block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes('=') && !line.startsWith('#'))
    .map((line) => {
      const separator = line.indexOf('=');
      const key = line.slice(0, separator).trim();
      return { key, value: line.slice(separator + 1).trim(), client: key.startsWith('VITE_') };
    });
}

const vercelDeployUrl = (): string | undefined => {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_VERCEL_DEPLOY_URL || undefined;
};
export default function SetupWizard({ onComplete, onAlreadyInstalled }: SetupWizardProps) {
  const [step, setStep] = useState(1);

  const [supabaseUrl, setSupabaseUrl] = useState('');
  const [supabaseKey, setSupabaseKey] = useState('');
  const [dbPassword, setDbPassword] = useState('');
  const [connectionString, setConnectionString] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [openDrawer, setOpenDrawer] = useState<string | null>(null);
  const [comingSoonNote, setComingSoonNote] = useState('');

  const [siteTitle, setSiteTitle] = useState('');
  const [siteTagline, setSiteTagline] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminPasswordConfirmation, setAdminPasswordConfirmation] = useState('');
  const [showAdminPassword, setShowAdminPassword] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [health, setHealth] = useState<Status | null>(null);
  const [envOutput, setEnvOutput] = useState('');
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'manual'>('idle');
  const [verifyStatus, setVerifyStatus] = useState('');
  const [installDone, setInstallDone] = useState(false);
  const [installMode, setInstallMode] = useState<'persistent' | 'serverless' | null>(null);
  const [adminReport, setAdminReport] = useState<AdminReport | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [installCheckNote, setInstallCheckNote] = useState('');

  const envRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const injected = (window as Window & {
      __REACT_WP_CONFIG__?: { supabaseUrl?: string; supabasePublishableKey?: string } | null;
    }).__REACT_WP_CONFIG__;
    if (injected?.supabaseUrl) setSupabaseUrl(injected.supabaseUrl);
    if (injected?.supabasePublishableKey) setSupabaseKey(injected.supabasePublishableKey);
  }, []);

  const validateStep1 = (): string => {
    const url = trim(supabaseUrl);
    if (!url) return 'Enter your Supabase project URL.';
    if (!SUPABASE_URL_PATTERN.test(url)) return 'The Supabase URL should look like https://your-project-ref.supabase.co';
    if (!trim(supabaseKey)) return 'Enter the publishable (anon) key from your Supabase project.';
    return '';
  };

  const validateStep2 = (): string => {
    if (!trim(siteTitle)) return 'Enter a site title.';
    if (!/^\S+@\S+\.\S+$/.test(trim(adminEmail))) return 'Enter a valid administrator email address.';
    if (adminPassword.length < 8) return 'The administrator password must be at least 8 characters long.';
    if (adminPassword !== adminPasswordConfirmation) return 'The administrator passwords do not match.';
    return '';
  };

  const connectionBody = (): Record<string, unknown> => ({
    dbType: 'supabase',
    supabaseUrl: trim(supabaseUrl),
    supabasePublishableKey: trim(supabaseKey),
    supabaseKey: trim(supabaseKey),
    databaseUrl: trim(connectionString) || undefined,
    connectionString: trim(connectionString) || undefined,
    dbPassword: trim(dbPassword) || undefined,
    password: trim(dbPassword) || undefined,
    connectionTimeoutMs: 15000,
  });

  const testConnection = async (): Promise<void> => {
    const validation = validateStep1();
    if (validation) {
      setError(validation);
      return;
    }
    setLoading(true);
    setError('');
    setHealth(null);
    try {
      const response = await fetch('/api/install/test-db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(connectionBody()),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        success?: boolean;
        error?: string;
        message?: string;
      };
      if (!response.ok || payload.ok === false || payload.success === false) {
        throw new Error(payload.error || payload.message || `Connection test failed (HTTP ${response.status}).`);
      }
      setHealth({ ok: true, message: payload.message || 'Connected to Supabase.' });
    } catch (err) {
      setHealth({ ok: false, message: err instanceof Error ? err.message : describeDbError(err) });
    } finally {
      setLoading(false);
    }
  };

  const createSupabaseAdmin = async (): Promise<string> => {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(trim(supabaseUrl).replace(/\/$/, ''), trim(supabaseKey));
    const { data, error } = await supabase.auth.signUp({
      email: trim(adminEmail),
      password: adminPassword,
      options: {
        emailRedirectTo: `${window.location.origin}/login`,
        data: { display_name: 'Administrator' },
      },
    });
    if (error && !/already\s*(registered|exists)|user_already_exists/i.test(error.message)) {
      throw new Error(`Admin account creation failed: ${error.message}`);
    }
    return data?.user?.id ?? '';
  };

  const installBody = (adminUserId: string): Record<string, unknown> => ({
    ...connectionBody(),
    deployment: 'serverless',
    saveSettings: false,
    storage: 'local',
    siteTitle: trim(siteTitle),
    siteTagline: trim(siteTagline),
    adminEmail: trim(adminEmail),
    adminPassword,
    adminUserId,
  });

  const runInstall = async (): Promise<void> => {
    const validation = validateStep2();
    if (validation) {
      setError(validation);
      return;
    }
    setLoading(true);
    setError('');
    setEnvOutput('');
    setVerifyStatus('');
    setInstallDone(false);
    setAdminReport(null);
    try {
      const adminUserId = await createSupabaseAdmin();
      const response = await fetch('/api/install-schema', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(installBody(adminUserId)),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        mode?: 'persistent' | 'serverless';
        installed?: boolean;
        env?: string;
        admin?: AdminReport | null;
        error?: string;
      };
      if (!response.ok || payload.success !== true) {
        throw new Error(payload.error || `Provisioning failed (HTTP ${response.status}).`);
      }
      setInstallMode(payload.mode === 'persistent' ? 'persistent' : 'serverless');
      setEnvOutput(payload.env || '');
      setAdminReport(payload.admin ?? null);
      setInstallDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Provisioning failed.');
    } finally {
      setLoading(false);
    }
  };

  const verifyAndLaunch = async (): Promise<void> => {
    setLoading(true);
    setVerifyStatus('Checking the deployed environment...');
    try {
      const response = await fetch('/api/install/check');
      const payload = (await response.json().catch(() => ({}))) as { installed?: boolean };
      if (payload.installed) {
        finishSetup();
        return;
      }
      setVerifyStatus('Not ready yet. Add the environment variables to Vercel, redeploy, then press Verify again.');
    } catch {
      setVerifyStatus('Could not reach the verification endpoint. Redeploy with the environment variables, then try again.');
    } finally {
      setLoading(false);
    }
  };

  const finishSetup = (): void => {
    resetClient();
    window.location.href = '/';
    onComplete?.();
  };

  const recheckInstall = async (): Promise<void> => {
    setRechecking(true);
    try {
      if (onAlreadyInstalled && (await onAlreadyInstalled())) return;
      setInstallCheckNote('The server still reports this site as not installed, so it is safe to continue.');
    } finally {
      setRechecking(false);
    }
  };

  const copyEnv = (): void => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(envOutput);
        setCopyStatus('copied');
      } catch {
        envRef.current?.focus();
        envRef.current?.select();
        setCopyStatus('manual');
      }
      window.setTimeout(() => setCopyStatus('idle'), 3000);
    })();
  };

  const downloadEnvFile = (): void => {
    downloadBlob(new Blob([envOutput], { type: 'text/plain;charset=utf-8' }), '.env.local');
  };

  const envRows = envOutput ? parseEnvBlock(envOutput) : [];
  const clientRows = envRows.filter((row) => row.client);
  const serverRows = envRows.filter((row) => !row.client);

  const adminNotice = (): ReactNode => {
    if (!adminReport) return null;
    const email = adminReport.email || trim(adminEmail);
    if (adminReport.role === 'administrator') {
      return (
        <div className={styles.successBox}>
          <strong>Administrator confirmed:</strong> <code>{email}</code> is in the <code>profiles</code> table with the <code>administrator</code> role.
        </div>
      );
    }
    return (
      <div className={styles.errorBox}>
        <strong>No administrator was created.</strong>{' '}
        {adminReport.warning || `The profile row for ${email} reports "${adminReport.role || 'no role'}".`}{' '}
        Register the account on <code>/register</code>, then run this step again, or promote it by hand under <strong>Users</strong> in the dashboard.
      </div>
    );
  };

  const comingSoonClick = (option: ComingSoonOption): void => {
    setComingSoonNote(`${option.label} is not available yet. This version deploys exclusively on Supabase + Vercel; ${option.label} is coming in a future release.`);
  };

  const drawer = (id: string, title: string, body: ReactNode): ReactNode => {
    const open = openDrawer === id;
    return (
      <div className={styles.drawer}>
        <button type="button" className={styles.drawerToggle} aria-expanded={open} onClick={() => setOpenDrawer(open ? null : id)}>
          <span className={styles.drawerTitle}>{title}</span>
          <span className={`${styles.drawerChevron} ${open ? styles.drawerChevronOpen : ''}`} aria-hidden="true">+</span>
        </button>
        {open && <div className={styles.drawerBody}>{body}</div>}
      </div>
    );
  };

  const comingSoonGrid = (options: ComingSoonOption[]): ReactNode => (
    <div className={styles.comingSoonGrid}>
      {options.map((option) => (
        <button key={option.id} type="button" className={styles.comingSoonCard} title="Coming Soon" onClick={() => comingSoonClick(option)}>
          <span className={styles.comingSoonLabel}>{option.label}</span>
          <span className={`${styles.badge} ${styles.badgeComing}`}>Coming Soon</span>
          <small>{option.hint}</small>
        </button>
      ))}
    </div>
  );
  const deployUrl = vercelDeployUrl();

  return (
    <div className={styles.container}>
      <div className={styles.wizard}>
        <aside className={styles.sidebar}>
          <div className={styles.brand}>React-WP Setup</div>
          <ol className={styles.stepperList}>
            {STEPS.map((item) => {
              const state = step > item.id ? 'done' : step === item.id ? 'active' : 'pending';
              return (
                <li key={item.id} className={`${styles.stepperItem} ${styles[`stepperItem${state[0].toUpperCase()}${state.slice(1)}`]}`}>
                  <span className={styles.stepNumber}>{state === 'done' ? 'ok' : item.id}</span>
                  <span className={styles.stepInfo}>
                    <span className={styles.stepTitle}>{item.title}</span>
                    <span className={styles.stepSubtitle}>{item.subtitle}</span>
                  </span>
                </li>
              );
            })}
          </ol>
          <div className={styles.sidebarNote}>
            <strong>This version</strong>
            Supabase + Vercel only. Other platforms and databases are marked as coming soon.
          </div>
        </aside>

        <main className={styles.content}>
          <div className={styles.card}>
            <header className={styles.cardHeader}>
              <h2>{STEPS[step - 1].title}</h2>
              <p>{STEPS[step - 1].subtitle}</p>
            </header>

            {step === 1 && (
              <>
                {onAlreadyInstalled && (
                  <div className={styles.guideBox}>
                    <strong>Is this site already installed?</strong> This wizard is for a site with no
                    database yet. If this one was set up before, the check that decides that failed rather
                    than the database being empty.{' '}
                    <button type="button" className={styles.guideToggle} onClick={() => void recheckInstall()} disabled={rechecking}>
                      {rechecking ? 'Checking...' : 'Re-check now'}
                    </button>
                    {installCheckNote && <p>{installCheckNote}</p>}
                  </div>
                )}

                {error && <div className={styles.errorBox}>{error}</div>}

                <div className={styles.formGroup}>
                  <label htmlFor="supabaseUrl">Supabase URL</label>
                  <input
                    id="supabaseUrl"
                    type="url"
                    value={supabaseUrl}
                    onChange={(event) => setSupabaseUrl(event.target.value)}
                    placeholder="https://your-project-ref.supabase.co"
                    autoComplete="url"
                  />
                  <small>Found under Project Settings -&gt; API in your Supabase dashboard.</small>
                </div>

                <div className={styles.formGroup}>
                  <label htmlFor="supabaseKey">Publishable / anon key</label>
                  <input
                    id="supabaseKey"
                    type={showKey ? 'text' : 'password'}
                    value={supabaseKey}
                    onChange={(event) => setSupabaseKey(event.target.value)}
                    placeholder="sb_publishable_..."
                    autoComplete="off"
                  />
                  <small>
                    The publishable key is safe to ship to the browser.{' '}
                    <button type="button" className={styles.revealButton} onClick={() => setShowKey((value) => !value)}>
                      {showKey ? 'Hide' : 'Show'}
                    </button>
                  </small>
                </div>

                <div className={styles.formGroup}>
                  <label htmlFor="dbPassword">Database password (recommended)</label>
                  <input
                    id="dbPassword"
                    type="password"
                    value={dbPassword}
                    onChange={(event) => setDbPassword(event.target.value)}
                    placeholder="The password you set for the postgres role"
                    autoComplete="off"
                  />
                  <small>Used once to create the tables and the administrator. It is never sent to the browser bundle.</small>
                </div>

                <button type="button" className={styles.guideToggle} onClick={() => setAdvancedOpen((value) => !value)}>
                  {advancedOpen ? 'Hide' : 'Show'} advanced connection string
                </button>
                {advancedOpen && (
                  <div className={styles.formGroup} style={{ marginTop: '0.75rem' }}>
                    <label htmlFor="connectionString">Full connection string (optional)</label>
                    <input
                      id="connectionString"
                      type="password"
                      value={connectionString}
                      onChange={(event) => setConnectionString(event.target.value)}
                      placeholder="postgresql://postgres:...@db.your-project-ref.supabase.co:5432/postgres"
                      autoComplete="off"
                    />
                    <small>If provided, it overrides the password above. Use the direct connection string, not the pooler.</small>
                  </div>
                )}

                <div className={styles.buttonRow}>
                  <button type="button" className={styles.buttonSecondary} onClick={() => void testConnection()} disabled={loading}>
                    {loading ? 'Testing...' : 'Test Connection'}
                  </button>
                </div>
                {health && (
                  <div className={health.ok ? styles.successBox : styles.errorBox}>{health.message}</div>
                )}

                <div className={styles.buttonRow}>
                  <button
                    type="button"
                    className={styles.buttonPrimary}
                    disabled={loading}
                    onClick={() => {
                      const validation = validateStep1();
                      if (validation) {
                        setError(validation);
                        return;
                      }
                      setStep(2);
                    }}
                  >
                    Continue
                  </button>
                </div>

                <h3 className={styles.sectionTitle}>Help with Supabase</h3>
                {drawer('url', 'Where do I find the URL and key?', (
                  <>
                    <p>Open your Supabase project, then go to <strong>Project Settings -&gt; API</strong>.</p>
                    <p>The <strong>Project URL</strong> is the Supabase URL, and the <strong>anon public</strong> or <strong>publishable</strong> key is the key.</p>
                    <ul className={styles.helpList}>
                      <li><a className={styles.helpLink} href="https://supabase.com/dashboard" target="_blank" rel="noopener noreferrer">Supabase Dashboard</a></li>
                      <li><a className={styles.helpLink} href="https://supabase.com/docs/guides/api/api-keys" target="_blank" rel="noopener noreferrer">API keys documentation</a></li>
                    </ul>
                  </>
                ))}
                {drawer('password', 'How do I find my database password?', (
                  <>
                    <p>Go to <strong>Project Settings -&gt; Database</strong> and reset the password for the <code>postgres</code> role if you do not remember it.</p>
                    <ul className={styles.helpList}>
                      <li><a className={styles.helpLink} href="https://supabase.com/docs/guides/database/connecting-to-postgres" target="_blank" rel="noopener noreferrer">Connecting to your database</a></li>
                    </ul>
                  </>
                ))}

                <h3 className={styles.sectionTitle}>Other databases</h3>
                <p className={styles.sectionHint}>React-WP will support more backends in a future release. They stay in the codebase but are disabled in this version.</p>
                {comingSoonGrid(OTHER_DATABASES)}

                <h3 className={styles.sectionTitle}>Other hosts</h3>
                <p className={styles.sectionHint}>This version deploys to Vercel. Self-hosted and edge targets are coming soon.</p>
                {comingSoonGrid(OTHER_HOSTS)}
                {comingSoonNote && <div className={styles.comingSoonNote}>{comingSoonNote}</div>}
              </>
            )}
            {step === 2 && (
              <>
                {error && <div className={styles.errorBox}>{error}</div>}

                <div className={styles.formGroup}>
                  <label htmlFor="siteTitle">Site title</label>
                  <input id="siteTitle" type="text" value={siteTitle} onChange={(event) => setSiteTitle(event.target.value)} placeholder="My React-WP Site" />
                </div>

                <div className={styles.formGroup}>
                  <label htmlFor="siteTagline">Tagline (optional)</label>
                  <input id="siteTagline" type="text" value={siteTagline} onChange={(event) => setSiteTagline(event.target.value)} placeholder="Just another React-WP site" />
                </div>

                <div className={styles.formGroup}>
                  <label htmlFor="adminEmail">Administrator email</label>
                  <input id="adminEmail" type="email" value={adminEmail} onChange={(event) => setAdminEmail(event.target.value)} placeholder="admin@example.com" autoComplete="email" />
                </div>

                <div className={styles.formGroup}>
                  <label htmlFor="adminPassword">Administrator password</label>
                  <input id="adminPassword" type={showAdminPassword ? 'text' : 'password'} value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} autoComplete="new-password" />
                  <small>
                    At least 8 characters.{' '}
                    <button type="button" className={styles.revealButton} onClick={() => setShowAdminPassword((value) => !value)}>
                      {showAdminPassword ? 'Hide' : 'Show'}
                    </button>
                  </small>
                </div>

                <div className={styles.formGroup}>
                  <label htmlFor="adminPasswordConfirmation">Confirm administrator password</label>
                  <input id="adminPasswordConfirmation" type={showAdminPassword ? 'text' : 'password'} value={adminPasswordConfirmation} onChange={(event) => setAdminPasswordConfirmation(event.target.value)} autoComplete="new-password" />
                </div>

                <div className={styles.buttonRow}>
                  <button type="button" className={styles.buttonSecondary} onClick={() => setStep(1)} disabled={loading}>Back</button>
                  <button type="button" className={styles.buttonPrimary} disabled={loading} onClick={() => {
                    const validation = validateStep2();
                    if (validation) {
                      setError(validation);
                      return;
                    }
                    setStep(3);
                  }}>Review & Deploy</button>
                </div>
              </>
            )}

            {step === 3 && !installDone && (
              <>
                {error && <div className={styles.errorBox}>{error}</div>}

                <p className={styles.guideBox}>
                  The installer connects to Supabase over a direct PostgreSQL connection, creates the core
                  tables (<code>options</code>, <code>posts</code>, <code>pages</code>, <code>profiles</code> and
                  more), promotes your administrator and returns the environment variables for Vercel.
                </p>

                <div className={styles.summaryList}>
                  <div><span>Host</span><strong>Vercel</strong></div>
                  <div><span>Database</span><strong>Supabase</strong></div>
                  <div><span>Site</span><strong>{siteTitle || 'My React-WP Site'}</strong></div>
                  <div><span>Admin</span><strong>{adminEmail}</strong></div>
                </div>

                <div className={styles.buttonRow}>
                  <button type="button" className={styles.buttonPrimary} onClick={() => void runInstall()} disabled={loading}>
                    {loading ? 'Provisioning...' : 'Finish Installation'}
                  </button>
                </div>
                <button type="button" className={styles.buttonSecondary} onClick={() => setStep(2)} disabled={loading}>Back</button>
              </>
            )}

            {step === 3 && installDone && (
              <>
                {adminNotice()}

                <div className={styles.envToolbar}>
                  <span className={styles.envToolbarTitle}>Environment variables for Vercel</span>
                  <div className={styles.envActions}>
                    <button type="button" className={styles.buttonSecondary} onClick={copyEnv}>
                      {copyStatus === 'copied' ? 'Copied' : copyStatus === 'manual' ? 'Selected - press Ctrl+C' : 'Copy'}
                    </button>
                    <button type="button" className={styles.buttonSecondary} onClick={downloadEnvFile}>Download .env.local</button>
                  </div>
                </div>

                <textarea ref={envRef} className={styles.envOutput} readOnly spellCheck={false} value={envOutput} onFocus={(event) => event.currentTarget.select()} aria-label="Generated environment variables" />

                <div className={styles.envGuide}>
                  <h3>Client variables</h3>
                  <ul className={styles.envTable}>
                    {clientRows.map((row) => (
                      <li key={row.key} className={`${styles.envRow} ${styles.envRowClient}`}>
                        <div className={styles.envRowHead}>
                          <span className={styles.envKey}>{row.key}</span>
                          <span className={styles.envValue}>{row.value}</span>
                        </div>
                        <p className={styles.envRowNote}>{VARIABLE_GUIDE[row.key] || 'Public client variable.'}</p>
                      </li>
                    ))}
                  </ul>

                  {serverRows.length > 0 && (
                    <>
                      <h3 className={styles.serverEnvTitle}>Server-only variables</h3>
                      <p className={styles.envRowNote}>
                        Add these as Vercel server variables, <strong>not</strong> as <code>VITE_</code> variables.
                        They are never sent to the browser.
                      </p>
                      <ul className={styles.envTable}>
                        {serverRows.map((row) => (
                          <li key={row.key} className={`${styles.envRow} ${styles.envRowServer}`}>
                            <div className={styles.envRowHead}>
                              <span className={styles.envKey}>{row.key}</span>
                              <span className={styles.envValue}>{row.value}</span>
                            </div>
                            <p className={styles.envRowNote}>{VARIABLE_GUIDE[row.key] || 'Server-only variable.'}</p>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>

                {installMode === 'serverless' && (
                  <p className={styles.envNote}>
                    Vercel keeps no writable filesystem, so the wizard could not save a config file. Paste
                    the variables above into <strong>Project -&gt; Settings -&gt; Environment Variables</strong>,
                    redeploy, then press Verify.
                  </p>
                )}

                {deployUrl ? (
                  <a className={styles.deployButton} href={deployUrl} target="_blank" rel="noopener noreferrer">Deploy to Vercel</a>
                ) : (
                  <div className={styles.guideBox}>
                    To enable the one-click <strong>Deploy to Vercel</strong> button, set{' '}
                    <code>VITE_VERCEL_DEPLOY_URL</code> to your Vercel deploy URL (see README). You can also
                    import this project from the Vercel dashboard.
                  </div>
                )}

                <div className={styles.guideBox}>
                  <strong>Last step, after you sign in:</strong> connect this site to your own GitHub repository and
                  Vercel project under <strong>Settings → Integrations → GitHub</strong> and then{' '}
                  <strong>GitHub &amp; Vercel</strong>. You enter your GitHub and Vercel tokens there once; from then on
                  plugin installs and core updates are committed to your repository and Vercel deploys them. Your tokens
                  stay on this site — React-WP.com never receives them. This needs <code>RWP_SECRET_BOX_KEY</code> in
                  this server&apos;s environment.
                </div>

                {verifyStatus && <p className={styles.guideBox}>{verifyStatus}</p>}

                <div className={styles.buttonRow}>
                  <button type="button" className={styles.buttonPrimary} onClick={() => void verifyAndLaunch()} disabled={loading}>
                    {loading ? 'Verifying...' : 'Verify & Launch Application'}
                  </button>
                </div>
                <button type="button" className={styles.buttonSecondary} onClick={() => setStep(2)} disabled={loading}>Back</button>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
