/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Dashboard from "@/app/dashboard/page.tsx";
import Design from "@/app/design/page.tsx";
import PanelSidebar from "@/app/sidebar/page.tsx";
import Workspaces from "@/app/workspaces/page.tsx";
import ProgressiveWebApp from "@/app/pwa/page.tsx";
import FloorpOS from "@/app/floorp-os/page.tsx";
import About from "./app/about/noraneko.tsx";
import ProfileAndAccount from "@/app/accounts/page.tsx";
import MouseGesture from "@/app/gesture/page.tsx";
import KeyboardShortcut from "@/app/keyboard-shortcut/page.tsx";
import Updates from "@/app/updates/page.tsx";
import { LeptonSettings } from "@/app/design/components/LeptonSettings.tsx";
import { AppBackground } from "@/components/app-background.tsx";
import SearchPage from "@/app/search/page.tsx";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppSidebar } from "@/components/app-sidebar.tsx";
import { Header } from "@/header/header.tsx";
import useHashSync from "@/hooks/useHashSync.ts";

export default function App() {
  const location = useLocation();
  useHashSync(location.pathname);

  // h-screen + overflow-hidden pins the shell to the viewport and gives the
  // content its OWN scroll container (the overflow-y-auto div below).
  // Relying on body/viewport scroll did not scroll in the about:hub content
  // context even though the document was tall — an explicit scroll region is
  // the reliable target.
  return (
    <div className="flex h-screen w-full flex-col overflow-hidden">
      <AppBackground />
      <div className="z-1 flex min-w-0 flex-1 overflow-hidden">
        <AppSidebar />
        <div className="min-w-0 flex-1 max-w-3xl flex flex-col overflow-hidden">
          <Header />
          <div className="flex-1 overflow-y-auto p-4">
            <Routes>
              <Route
                path="/"
                element={<Navigate to="/overview/home" replace />}
              />
              <Route path="/search" element={<SearchPage />} />
              <Route path="/overview/home" element={<Dashboard />} />
              <Route path="/features/design" element={<Design />} />
              <Route
                path="/features/design/lepton"
                element={<LeptonSettings />}
              />
              <Route path="/features/sidebar" element={<PanelSidebar />} />
              <Route path="/features/workspaces" element={<Workspaces />} />
              <Route path="/features/webapps" element={<ProgressiveWebApp />} />
              <Route path="/features/floorp-os" element={<FloorpOS />} />
              <Route
                path="/features/accounts"
                element={<ProfileAndAccount />}
              />
              <Route path="features/gesture" element={<MouseGesture />} />
              <Route
                path="/features/shortcuts"
                element={<KeyboardShortcut />}
              />
              <Route path="/about/browser" element={<About />} />
              <Route path="/about/updates" element={<Updates />} />
            </Routes>
          </div>
        </div>
      </div>
    </div>
  );
}
