import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClientProvider } from "@tanstack/react-query"

import "./index.css"
import App from "./App.tsx"
import { queryClient } from "@/lib/query"
import { DaemonRuntimeProvider } from "@/lib/runtime"
import { sameOriginWebTransport } from "@/lib/web-transport"

const reloadWebApp = () => window.location.reload()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <DaemonRuntimeProvider
        transport={sameOriginWebTransport}
        recoverAfterUpdate={reloadWebApp}
      >
        <App />
      </DaemonRuntimeProvider>
    </QueryClientProvider>
  </StrictMode>
)
