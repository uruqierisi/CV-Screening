import { Link } from 'react-router-dom';

/**
 * An unrouted path. Names the paths that do exist rather than shrugging.
 */
export function NotFoundPage() {
  return (
    <div className="state">
      <h1 className="state__title">No such page</h1>
      <p className="state__detail">
        This address does not match any screen in this application.
      </p>
      <p className="state__detail">
        The screens are <Link to="/roles">Roles</Link>, <Link to="/upload">Upload CVs</Link> and{' '}
        <Link to="/dashboard">Dashboard</Link>.
      </p>
    </div>
  );
}
