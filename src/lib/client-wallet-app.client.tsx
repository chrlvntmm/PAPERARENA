import "@tanstack/react-start/client-only";
import "./buffer-polyfill";

import type { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { WalletProvider } from "./wallet";
import { WalletKitProvider } from "./wallet-kit";

export function ClientWalletApp({
  children,
  queryClient,
}: {
  children: ReactNode;
  queryClient: QueryClient;
}) {
  return (
    <WalletKitProvider queryClient={queryClient}>
      <WalletProvider>{children}</WalletProvider>
    </WalletKitProvider>
  );
}
