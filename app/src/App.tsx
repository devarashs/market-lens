import { useEffect } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { startConnection } from "./lib/connection";
import { DocsPage } from "./pages/DocsPage";
import { LensPage } from "./pages/LensPage";
import { MarketsPage } from "./pages/MarketsPage";

export function App() {
  // One socket for the app's lifetime; startConnection is idempotent, so
  // StrictMode's double-mount costs nothing.
  useEffect(() => {
    startConnection();
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/docs" element={<DocsPage />} />
        <Route path="/markets" element={<MarketsPage />} />
        <Route path="/:symbol?/:timeframe?" element={<LensPage />} />
      </Routes>
    </BrowserRouter>
  );
}
