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
import { DaemonRuntimeProvider } from "@/lib/runtime"
import { sameOriginWebTransport } from "@/lib/web-transport"

const reloadWebApp = () => window.location.reload()
const desktopBootstrap = isTauri() ? desktopBridge.bootstrap() : null

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {desktopBootstrap ? (
        <DesktopBootstrapScreen promise={desktopBootstrap}>
          {(bootstrap) => (
            <DesktopApplicationProvider initial={bootstrap}>
              <App />
            </DesktopApplicationProvider>
          )}
        </DesktopBootstrapScreen>
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
