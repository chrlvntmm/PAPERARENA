import { QueryClient } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  ClientOnly,
  Scripts,
} from "@tanstack/react-router";
import { lazy, Suspense, useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";

const ClientWalletApp = lazy(() =>
  import("../lib/client-wallet-app.client").then((module) => ({ default: module.ClientWalletApp })),
);

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold neon-text-white font-display">404</h1>
        <p className="mt-4 text-muted-foreground">Off the grid.</p>
        <Link to="/" className="mt-6 inline-block px-4 py-2 neon-border rounded">Return to Arena</Link>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  useEffect(() => { reportLovableError(error, { boundary: "tanstack_root_error_component" }); }, [error]);
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold neon-text-white">Connection lost</h1>
        <button onClick={() => { router.invalidate(); reset(); }} className="mt-6 px-4 py-2 neon-border rounded">Retry</button>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "PaperArena — Skill-Based Betting" },
      { name: "description", content: "Skill-based paper.io style multiplayer betting arena. Capture territory, eliminate rivals, claim the pot." },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Rajdhani:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head><HeadContent /></head>
      <body>{children}<Scripts /></body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  return (
    <ClientOnly fallback={<AppLoading />}>
      <Suspense fallback={<AppLoading />}>
        <ClientWalletApp queryClient={queryClient}>
          <Outlet />
        </ClientWalletApp>
      </Suspense>
    </ClientOnly>
  );
}

function AppLoading() {
  return (
    <main className="min-h-screen bg-background">
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="font-display text-sm font-bold uppercase tracking-[0.3em] text-muted-foreground">
          Loading PaperArena
        </div>
      </div>
    </main>
  );
}
