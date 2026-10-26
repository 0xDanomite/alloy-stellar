import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "./index.css";
import { Layout } from "./components/Layout";
import { WalletProvider } from "./lib/wallet";
import { Landing } from "./pages/Landing";
import { FundPage } from "./pages/FundPage";
import { FundsPage } from "./pages/FundsPage";
import { Built } from "./pages/Built";
import { CreatePage } from "./pages/CreatePage";
import { NotFound } from "./pages/NotFound";

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <Landing /> },
      { path: "/funds", element: <FundsPage /> },
      { path: "/fund/:id", element: <FundPage /> },
      { path: "/create", element: <CreatePage /> },
      { path: "/built", element: <Built /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

createRoot(root).render(
  <StrictMode>
    <WalletProvider>
      <RouterProvider router={router} />
    </WalletProvider>
  </StrictMode>,
);
