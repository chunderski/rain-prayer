import { BrowserRouter, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import type { ApiClient } from "./api/client";
import { AppShell, OfflineBanner } from "./components/AppShell";
import { Loading } from "./components/ui";
import { SignIn } from "./screens/SignIn";
import { AssessmentDetail, AssessmentsHome } from "./screens/Assessments";
import { ClientDetail, ClientsList } from "./screens/Clients";
import { NewAssessment } from "./screens/NewAssessment";
import { ControlDetailScreen, Library } from "./screens/Library";
import { SyncProvider } from "./sync/SyncContext";
import { FieldLayout } from "./field/FieldContext";
import { WalkthroughHome, WalkthroughStep } from "./screens/Walkthrough";
import { PhotoDetail, PhotosList, PhotoTagScreen } from "./screens/Photos";
import { FindingEdit, FindingsList } from "./screens/Findings";
import { AreasScreen, AssessorsScreen } from "./screens/Admin";
import { SyncReview } from "./screens/SyncReview";
import { Dashboard } from "./screens/Dashboard";
import { CompareScreen } from "./screens/Compare";
import { RiskInputsScreen } from "./screens/RiskInputs";
import { RiskResultsScreen } from "./screens/RiskResults";
import { ReportScreen } from "./screens/Report";
import { IntegrationsScreen } from "./screens/Settings";
import { PinLock } from "./auth/PinScreens";
import { useCanAdmin } from "./auth/AuthContext";
import { Banner } from "./components/ui";
import { shellFor } from "./auth/AuthContext";
import { BrandingProvider } from "./branding/BrandingContext";
import { BrandingScreen } from "./screens/Branding";
import { MembersScreen, SetupScreen } from "./screens/Members";
import { PriceBookScreen } from "./screens/PriceBook";
import { QuoteEditorScreen, QuotesScreen } from "./screens/Quotes";
import { PortalApp } from "./screens/Portal";
import { PortfolioScreen } from "./screens/Portfolio";

/** Admins land on the dashboard; everyone else on the assessments list. */
function Home() {
  return useCanAdmin() ? <Dashboard /> : <AssessmentsHome />;
}

function Gate() {
  const { status, locked, notice, session } = useAuth();
  const { pathname } = useLocation();
  // Setup links work signed out (new members) and replace any session on this device once used.
  if (pathname === "/setup") return <SetupScreen />;
  if (status === "loading") return <Loading label="Starting Sentinel Assess" />;
  if (status === "signed_out")
    return (
      <>
        <OfflineBanner />
        {notice && (
          <div className="px-4 pt-3">
            <Banner tone="warn" live>
              {notice}
            </Banner>
          </div>
        )}
        <SignIn />
      </>
    );
  // R2-5: nothing from the cached workspace renders (and nothing syncs) until the PIN is entered.
  if (locked) return <PinLock />;
  // Client viewers get the portal only: no field tools, sync, or PIN prompt (D-081).
  if (shellFor(session?.role) === "portal") return <PortalApp />;
  return (
    <SyncProvider>
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Home />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="compare" element={<CompareScreen />} />
        <Route path="settings/integrations" element={<IntegrationsScreen />} />
        <Route path="settings/branding" element={<BrandingScreen />} />
        <Route path="settings/members" element={<MembersScreen />} />
        <Route path="settings/price-book" element={<PriceBookScreen />} />
        <Route path="portfolio" element={<PortfolioScreen />} />
        <Route path="assessments/new" element={<NewAssessment />} />
        <Route path="assessments/:id" element={<FieldLayout />}>
          <Route index element={<AssessmentDetail />} />
          <Route path="walkthrough" element={<WalkthroughHome />} />
          <Route path="walkthrough/:areaKey" element={<WalkthroughStep />} />
          <Route path="photos" element={<PhotosList />} />
          <Route path="photos/:photoId" element={<PhotoDetail />} />
          <Route path="photos/:photoId/tag" element={<PhotoTagScreen />} />
          <Route path="findings" element={<FindingsList />} />
          <Route path="findings/new" element={<FindingEdit />} />
          <Route path="findings/:findingId" element={<FindingEdit key="edit" />} />
          <Route path="assessors" element={<AssessorsScreen />} />
          <Route path="areas" element={<AreasScreen />} />
          <Route path="risk" element={<RiskResultsScreen />} />
          <Route path="risk/inputs" element={<RiskInputsScreen />} />
          <Route path="report" element={<ReportScreen />} />
          <Route path="quotes" element={<QuotesScreen />} />
          <Route path="quotes/:quoteId" element={<QuoteEditorScreen key="quote" />} />
        </Route>
        <Route path="sync" element={<SyncReview />} />
        <Route path="clients" element={<ClientsList />} />
        <Route path="clients/:id" element={<ClientDetail />} />
        <Route path="library" element={<Library />} />
        <Route path="library/:controlId" element={<ControlDetailScreen />} />
        <Route path="*" element={<Home />} />
      </Route>
    </Routes>
    </SyncProvider>
  );
}

export interface AppProps {
  /**
   * "browser" for the standalone PWA and iframe embeds (owns the URL);
   * "memory" for the <sentinel-assess> web component, so the host page URL is never touched.
   */
  router?: "browser" | "memory";
  initialPath?: string;
  client?: ApiClient;
}

export function App({ router = "browser", initialPath = "/", client }: AppProps) {
  const body = (
    <div className="min-h-dvh bg-bg text-lg text-ink">
      <AuthProvider client={client}>
        <BrandingProvider>
          <Gate />
        </BrandingProvider>
      </AuthProvider>
    </div>
  );
  return router === "memory" ? <MemoryRouter initialEntries={[initialPath]}>{body}</MemoryRouter> : <BrowserRouter>{body}</BrowserRouter>;
}
