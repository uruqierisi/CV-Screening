/**
 * The route table and the shell around it.
 *
 * Plan section 6's routes, and nothing invented beyond them. `/` redirects to
 * `/roles` because a role is the prerequisite for every other screen: you cannot
 * upload a CV without one and you cannot rank candidates without one.
 *
 * The dashboard's filters, sort and page live in the **URL** rather than in
 * component state, so "Strong Match candidates for Senior Backend Engineer" is a
 * link a recruiter can bookmark and send to a colleague.
 */

import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { RolesPage } from './pages/RolesPage.jsx';
import { RoleNewPage } from './pages/RoleNewPage.jsx';
import { RoleEditPage } from './pages/RoleEditPage.jsx';
import { UploadPage } from './pages/UploadPage.jsx';
import { DashboardPage } from './pages/DashboardPage.jsx';
import { CandidateDetailPage } from './pages/CandidateDetailPage.jsx';
import { NotFoundPage } from './pages/NotFoundPage.jsx';

export function App() {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>

      <header className="app-header">
        <div className="app-header__inner">
          <p className="app-header__title">CV Screening</p>
          <nav className="app-nav" aria-label="Main">
            <NavLink to="/roles">Roles</NavLink>
            <NavLink to="/upload">Upload CVs</NavLink>
            <NavLink to="/dashboard">Dashboard</NavLink>
          </nav>
        </div>
      </header>

      <main className="app-main" id="main">
        <Routes>
          <Route path="/" element={<Navigate to="/roles" replace />} />
          <Route path="/roles" element={<RolesPage />} />
          <Route path="/roles/new" element={<RoleNewPage />} />
          <Route path="/roles/:roleId/edit" element={<RoleEditPage />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/candidates/:candidateId" element={<CandidateDetailPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </div>
  );
}
