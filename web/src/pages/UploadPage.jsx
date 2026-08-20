/**
 * `/upload` - choose a role, choose CVs, watch them go.
 *
 * Two genuinely different phases, kept separate rather than blurred into one bar
 * (plan section 6):
 *
 * 1. **The HTTP upload**, which has real byte progress, per file, derived from
 *    the request's own counter in `lib/uploadProgress.js`.
 * 2. **The server pipeline**, which has no progress to report and gets a stepper
 *    instead. See `PipelineStepper.jsx` for why a percentage there would be a lie.
 *
 * The role is in the URL (`?roleId=…`), so a link to this screen can arrive
 * pre-aimed at a role - which is how `/roles` and `/roles/new` hand off to it.
 */

import { useCallback, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { listRoles } from '../api/roles.js';
import { uploadCandidates } from '../api/uploads.js';
import { useConfig } from '../config/ConfigProvider.jsx';
import { useResource } from '../hooks/useResource.js';
import { Spinner } from '../components/Spinner.jsx';
import { EmptyState, ErrorState } from '../components/States.jsx';
import { SelectField } from '../components/Field.jsx';
import { formatBytes, pluralize } from '../lib/format.js';
import { allocateProgress, checkFiles } from '../lib/uploadProgress.js';
import { ScreeningProgress } from '../features/upload/ScreeningProgress.jsx';

export function UploadPage() {
  const config = useConfig();
  const [searchParams, setSearchParams] = useSearchParams();
  const roleId = searchParams.get('roleId') ?? '';

  const rolesFetcher = useCallback((signal) => listRoles({ pageSize: 100, signal }), []);
  const { data: roles, loading: rolesLoading, error: rolesError, reload } =
    useResource(rolesFetcher);

  const [files, setFiles] = useState(/** @type {File[]} */ ([]));
  const [problems, setProblems] = useState(
    /** @type {Array<{ file: string, message: string }>} */ ([]),
  );
  const [loaded, setLoaded] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(/** @type {any} */ (null));
  const [accepted, setAccepted] = useState(
    /** @type {{ candidates: any[], meta: any, at: number } | null} */ (null),
  );
  const fileInputRef = useRef(/** @type {HTMLInputElement | null} */ (null));

  if (rolesLoading) return <Spinner label="Loading roles" />;

  if (rolesError !== null) {
    return (
      <ErrorState
        title="The role list could not be loaded"
        error={rolesError}
        hint="A CV is always screened against a role, so one has to be chosen before anything can be uploaded."
        onRetry={reload}
      />
    );
  }

  if (roles.length === 0) {
    return (
      <EmptyState
        title="There is no role to upload against"
        message="Every CV is screened against exactly one role's rubric. Create a role first, then come back here."
        action={
          <Link className="button button--primary" to="/roles/new">
            Create a role
          </Link>
        }
      />
    );
  }

  const selectedRole = roles.find((role) => role.id === roleId) ?? null;
  const progress = allocateProgress(
    files.map((file) => ({ name: file.name, size: file.size })),
    loaded,
  );
  const totalBytes = files.reduce((total, file) => total + file.size, 0);

  const onChooseFiles = (event) => {
    const chosen = Array.from(event.target.files ?? []);
    setFiles(chosen);
    setLoaded(0);
    setUploadError(null);
    setProblems(chosen.length === 0 ? [] : checkFiles(chosen, config.upload));
  };

  const onUpload = async (event) => {
    event.preventDefault();
    if (uploading || selectedRole === null) return;

    const found = checkFiles(files, config.upload);
    setProblems(found);
    if (found.length > 0) return;

    setUploading(true);
    setUploadError(null);
    setLoaded(0);

    const { result } = uploadCandidates({
      roleId: selectedRole.id,
      files,
      onProgress: ({ loaded: sent }) => setLoaded(sent),
    });

    try {
      const { data, meta } = await result;
      setAccepted({ candidates: data.candidates, meta, at: Date.now() });
    } catch (caught) {
      setUploadError(caught);
    } finally {
      setUploading(false);
    }
  };

  const startOver = () => {
    setAccepted(null);
    setFiles([]);
    setProblems([]);
    setLoaded(0);
    setUploadError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Upload CVs</h1>
          <p className="lede">
            Files are accepted immediately and screened in the background, so this page can be left
            open or come back to later. PDF, DOCX and plain text, up to{' '}
            {formatBytes(config.upload.maxFileBytes)} each and{' '}
            {config.upload.maxBatchFiles} per upload.
          </p>
        </div>
      </div>

      <section className="panel">
        <SelectField
          label="Screen against this role"
          value={roleId}
          options={[
            { value: '', label: 'Choose a role…' },
            ...roles.map((role) => ({
              value: role.id,
              label: `${role.title} (v${role.version})`,
            })),
          ]}
          disabled={uploading || accepted !== null}
          onChange={(value) =>
            setSearchParams(value === '' ? {} : { roleId: value }, { replace: true })
          }
        />

        {selectedRole !== null ? (
          <p className="muted">
            {pluralize(selectedRole.criteria.length, 'criterion', 'criteria')},{' '}
            {pluralize(selectedRole.eliminationRules.length, 'elimination rule')}.{' '}
            <Link to={`/roles/${selectedRole.id}/edit`}>Review the rubric</Link> before spending on
            a batch — there is no rescore after an edit.
          </p>
        ) : null}
      </section>

      {accepted === null ? (
        <form className="panel" onSubmit={onUpload}>
          <div className="field">
            <label className="field__label" htmlFor="cv-files">
              CV files
            </label>
            <span className="field__hint" id="cv-files-hint">
              Choose one or more files. Uploading the same file to the same role twice does not
              screen it twice and does not cost anything.
            </span>
            <input
              id="cv-files"
              ref={fileInputRef}
              type="file"
              multiple
              accept={config.upload.acceptedMimeTypes.join(',')}
              aria-describedby="cv-files-hint"
              disabled={uploading}
              onChange={onChooseFiles}
            />
          </div>

          {problems.length > 0 ? (
            <div className="state state--error" role="alert">
              <h2 className="state__title">These files cannot be uploaded</h2>
              <ul>
                {problems.map((problem) => (
                  <li key={`${problem.file}:${problem.message}`}>
                    {problem.file ? <strong>{problem.file}</strong> : null} {problem.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {uploadError !== null ? (
            <ErrorState
              title="The upload was rejected"
              error={uploadError}
              hint={
                uploadError.code === 'RATE_LIMITED'
                  ? 'Uploads are rate limited because each CV costs real money to screen. Nothing was charged.'
                  : 'Nothing was screened, so nothing was charged. The chosen files are still selected.'
              }
            />
          ) : null}

          {files.length > 0 ? (
            <ul className="file-list">
              {/*
                No server id exists yet - these files have not been uploaded.
                Name and size together are the most stable identity available,
                and far better than an index, which would hand a row the
                previous row's progress after a re-pick.
              */}
              {progress.map((file) => (
                <li key={`${file.name}:${file.size}`} className="file-row">
                  <div className="file-row__head">
                    <span className="file-row__name">{file.name}</span>
                    <span className="muted">{formatBytes(file.size)}</span>
                  </div>
                  {uploading || loaded > 0 ? (
                    <>
                      <progress
                        value={file.percent}
                        max={100}
                        aria-label={`Upload progress for ${file.name}`}
                      />
                      <span className="muted">
                        {file.state === 'sent'
                          ? 'Sent'
                          : file.state === 'sending'
                            ? `Sending — ${file.percent}%`
                            : 'Waiting'}
                      </span>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="button-row" style={{ marginTop: 'var(--space-4)' }}>
            <button
              type="submit"
              className="button button--primary"
              disabled={uploading || selectedRole === null || files.length === 0}
            >
              {uploading
                ? `Uploading ${formatBytes(loaded)} of ${formatBytes(totalBytes)}…`
                : `Upload ${pluralize(files.length, 'file')}`}
            </button>
            {selectedRole === null ? (
              <span className="muted">Choose a role first.</span>
            ) : null}
          </div>
        </form>
      ) : (
        <>
          <ScreeningProgress
            roleId={roleId}
            uploaded={accepted.candidates}
            meta={accepted.meta}
            acceptedAt={accepted.at}
          />
          <div className="button-row">
            <button type="button" className="button" onClick={startOver}>
              Upload more CVs
            </button>
          </div>
        </>
      )}
    </>
  );
}
