import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { connectWallet, disconnectWallet, explain, restoreWallet } from "./stellar";

interface WalletState {
  address: string | null;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    restoreWallet().then((restored) => {
      if (restored) setAddress(restored);
    });
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      setAddress(await connectWallet());
    } catch (err) {
      const message = explain(err);
      if (!/closed|declined/i.test(message)) setError(message);
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    await disconnectWallet().catch(() => undefined);
    setAddress(null);
  }, []);

  const value = useMemo(
    () => ({ address, connecting, error, connect, disconnect }),
    [address, connecting, error, connect, disconnect],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside WalletProvider");
  return ctx;
}
