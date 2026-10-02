import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClientProvider } from "@tanstack/react-query"
import { isTauri } from "@tauri-apps/api/core"

import "./index.css"
import App from "./App.tsx"
import { AppErrorBoundary } from "@/components/error-boundary"
import { DesktopBootstrapScreen } from "@/components/desktop-bootstrap-screen"
import { queryClient } from "@/lib/query"
import { desktopBridge } from "@/lib/desktop-bridge"
import { DesktopApplicationProvider } from "@/lib/desktop-connections"
import { DesktopUpdaterProvider } from "@/lib/desktop-updater"
import { DesktopZoomProvider } from "@/lib/desktop-zoom"
import { DaemonRuntimeProvider } from "@/lib/runtime"
import { initTheme } from "@/lib/theme"
import { initPwa } from "@/lib/pwa"
import { initTitleTips } from "@/lib/title-tips"
import { sameOriginWebTransport } from "@/lib/web-transport"

// before the first render, so a light preference does not arrive mid-paint
initTheme()
initTitleTips()

const reloadWebApp = () => window.location.reload()
const desktopBootstrap = isTauri() ? desktopBridge.bootstrap() : null
if (!desktopBootstrap) initPwa()

createRoot(document.getElementById("root")!, {
  // AppErrorBoundary logs the one line this needs (error-boundary.tsx);
  // React's own default onCaughtError would otherwise repeat it as a second,
  // noisier console entry for every error a boundary already reported.
  onCaughtError: () => {},
}).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AppErrorBoundary>
        {desktopBootstrap ? (
          <DesktopZoomProvider>
            <DesktopBootstrapScreen promise={desktopBootstrap}>
              {(bootstrap) => (
                <DesktopUpdaterProvider>
                  <DesktopApplicationProvider initial={bootstrap}>
                    <App />
                  </DesktopApplicationProvider>
                </DesktopUpdaterProvider>
              )}
            </DesktopBootstrapScreen>
          </DesktopZoomProvider>
        ) : (
          <DaemonRuntimeProvider
            transport={sameOriginWebTransport}
            recoverAfterUpdate={reloadWebApp}
          >
            <App />
          </DaemonRuntimeProvider>
        )}
      </AppErrorBoundary>
    </QueryClientProvider>
  </StrictMode>
)
