import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import AppProvider from './context/AppContext.tsx'
import { registerBuiltinShortcodes } from './lib/builtin-shortcodes.tsx'
import { bootRemotePlugins } from './lib/remotePlugins'
import './index.css'

registerBuiltinShortcodes()

// Hybrid architecture: ask the central server which premium plugins this site is licensed for, and
// inject their bundles. A no-op for the free core (no stored identity) and on any failure.
bootRemotePlugins()

// Bundled plugins are discovered by folder convention at build time.
import.meta.glob('../plugins/*/index.tsx', { eager: true })

// The admin and the public site have separate default languages (Settings → Languages), so the
// provider needs to know which one it is wrapping before it resolves the locale.
const surface = window.location.pathname.replace(/\/+$/, '') === '/admin' ? 'admin' : 'public'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppProvider surface={surface}>
      <App />
    </AppProvider>
  </React.StrictMode>,
)