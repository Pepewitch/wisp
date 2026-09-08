import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClientProvider } from "@tanstack/react-query"
import { isTauri } from "@tauri-apps/api/core"

import "./index.css"
import App from "./App.tsx"
import { DesktopBootstrapScreen } from "@/components/desktop-bootstrap-screen"
import { queryClient } from "@/lib/query"
import { desktopBridge } from "@/lib/desktop-bridge"
import { DesktopApplicationProvider } from "@/lib/desktop-connections"
import { DesktopUpdaterProvider } from "@/lib/desktop-updater"
import { DesktopZoomProvider } from "@/lib/desktop-zoom"
import { DaemonRuntimeProvider } from "@/lib/runtime"
import { initTheme } from "@/lib/theme"
import { sameOriginWebTransport } from "@/lib/web-transport"

// before the first render, so a light preference does not arrive mid-paint
initTheme()

const reloadWebApp = () => window.location.reload()
const desktopBootstrap = isTauri() ? desktopBridge.bootstrap() : null

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
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
    </QueryClientProvider>
  </StrictMode>
)
