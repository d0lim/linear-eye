import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Bootstrap, Change, ChangesResult, Issue, MilestoneProgress, ProjectProgress, TeamWork } from './types';
import { getJson, SessionExpired } from './api';
import { defaultDateRange, prettyDate, prettyTime } from './dates';
import './styles.css';

type View = 'team' | 'projects' | 'activity';
type LoadState<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: T };
const iconPaths: Record<string, React.ReactNode> = {
  eye: <><path d="M2 12s3.7-6 10-6 10 6 10 6-3.7 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.7"/></>,
  team: <><circle cx="9" cy="8" r="3"/><path d="M3 20v-1.5A5.5 5.5 0 0 1 8.5 13h1A5.5 5.5 0 0 1 15 18.5V20M16 5.2a3 3 0 0 1 0 5.7m2 2.4a5 5 0 0 1 3 4.6V20"/></>,
  project: <><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M7 8h10M7 12h6M7 16h8"/></>,
  activity: <><path d="M3 12h4l3-8 4 16 3-8h4"/></>,
  chevron: <path d="m7 10 5 5 5-5"/>,
  arrow: <><path d="M7 17 17 7M7 7h10v10"/></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2"/></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></>,
};
function Icon({ name, size = 18 }: { name: string; size?: number }) { return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{iconPaths[name]}</svg>; }

function titleCase(value: string): string { return value.replace(/[_-]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function percent(value: number | null): string { return value === null ? '—' : `${Math.round(value * 100)}%`; }
function plural(count: number, noun: string): string { return `${count} ${noun}${count === 1 ? '' : 's'}`; }
function trustedIssueUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && (url.hostname === 'linear.app' || url.hostname.endsWith('.linear.app')) ? url.href : null; }
  catch { return null; }
}
function linkedIssue(issue: Pick<Issue, 'url' | 'identifier' | 'title'>) {
  const url = trustedIssueUrl(issue.url);
  return <>{url ? <a className="issue-link" href={url} target="_blank" rel="noreferrer"><span>{issue.identifier}</span><Icon name="arrow" size={13}/></a> : <span className="issue-key">{issue.identifier}</span>}<span className="issue-title">{issue.title}</span></>;
}

function App() {
  const [view, setView] = useState<View>(() => location.hash.match(/\/(team|projects|activity)/)?.[1] as View ?? 'team');
  const [bootstrap, setBootstrap] = useState<LoadState<Bootstrap>>({ status: 'loading' });
  const [team, setTeam] = useState(''); const [project, setProject] = useState(''); const [milestone, setMilestone] = useState('');
  const [includeStale, setIncludeStale] = useState(true);
  const [teamData, setTeamData] = useState<LoadState<TeamWork>>({ status: 'loading' });
  const [projectData, setProjectData] = useState<LoadState<ProjectProgress>>({ status: 'loading' });
  const [milestoneData, setMilestoneData] = useState<LoadState<MilestoneProgress> | null>(null);
  const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [member, setMember] = useState(''); const [activityProject, setActivityProject] = useState('');
  const [changes, setChanges] = useState<LoadState<ChangesResult>>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [paginationError, setPaginationError] = useState<string | null>(null);
  const activityGeneration = useRef(0);
  const [sessionExpired, setSessionExpired] = useState(false);
  const controllers = useRef<Record<string, AbortController>>({});
  const bootstrapController = useRef<AbortController | null>(null);
  const api = useCallback(async <T,>(key: string, path: string): Promise<T> => {
    controllers.current[key]?.abort(); const controller = new AbortController(); controllers.current[key] = controller;
    try { return await getJson<T>(path, controller.signal); }
    catch (error) { if (!controller.signal.aborted && error instanceof SessionExpired) setSessionExpired(true); throw error; }
  }, []);
  const loadBootstrap = useCallback(() => {
    bootstrapController.current?.abort(); const controller = new AbortController(); bootstrapController.current = controller;
    setBootstrap({ status: 'loading' });
    getJson<Bootstrap>('/api/bootstrap', controller.signal).then((data) => {
      setBootstrap({ status: 'ready', data });
      const range = defaultDateRange(new Date(), data.timezone || 'UTC');
      setFrom((current) => current || range.from); setTo((current) => current || range.to);
      setTeam((current) => current || data.teams[0]?.id || ''); setProject((current) => current || data.projects[0]?.id || '');
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setBootstrap({ status: 'error', message: error instanceof Error ? error.message : 'Could not load your workspace.' });
    });
  }, []);
  const loadTeam = useCallback(() => {
    setTeamData({ status: 'loading' });
    const query = new URLSearchParams({ includeStale: String(includeStale) }); if (team) query.set('team', team);
    api<TeamWork>('team', `/api/team?${query}`).then((data) => setTeamData({ status: 'ready', data })).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setTeamData({ status: 'error', message: error instanceof Error ? error.message : 'Could not load team work.' });
    });
    return () => controllers.current.team?.abort();
  }, [api, includeStale, team]);
  const loadProject = useCallback(() => {
    if (!project) return () => {};
    setProjectData({ status: 'loading' });
    api<ProjectProgress>('project', `/api/project?${new URLSearchParams({ project })}`).then((data) => setProjectData({ status: 'ready', data })).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setProjectData({ status: 'error', message: error instanceof Error ? error.message : 'Could not load project progress.' });
    });
    return () => { controllers.current.project?.abort(); controllers.current.milestone?.abort(); };
  }, [api, project]);
  const loadActivity = useCallback(() => {
    const generation = ++activityGeneration.current;
    controllers.current.more?.abort();
    setLoadingMore(false);
    setPaginationError(null);
    setChanges({ status: 'loading' });
    const query = new URLSearchParams({ from, to, limit: '30' }); if (member) query.set('member', member); if (activityProject) query.set('project', activityProject);
    api<ChangesResult>('changes', `/api/changes?${query}`).then((data) => {
      if (generation === activityGeneration.current) setChanges({ status: 'ready', data });
    }).catch((error: unknown) => {
      if (generation !== activityGeneration.current || (error instanceof DOMException && error.name === 'AbortError')) return;
      setChanges({ status: 'error', message: error instanceof Error ? error.message : 'Could not load activity.' });
    });
    return () => {
      ++activityGeneration.current;
      controllers.current.changes?.abort();
      controllers.current.more?.abort();
    };
  }, [activityProject, api, from, member, to]);
  useEffect(() => { loadBootstrap(); return () => { bootstrapController.current?.abort(); Object.values(controllers.current).forEach((controller) => controller.abort()); }; }, [loadBootstrap]);
  useEffect(() => {
    const onHash = () => { const match = location.hash.match(/\/(team|projects|activity)/); if (match) setView(match[1] as View); };
    addEventListener('hashchange', onHash); return () => removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (bootstrap.status !== 'ready' || view !== 'team') return;
    return loadTeam();
  }, [bootstrap.status, loadTeam, view]);
  useEffect(() => {
    if (bootstrap.status !== 'ready' || view !== 'projects' || !project) return;
    setMilestone(''); setMilestoneData(null);
    return loadProject();
  }, [bootstrap.status, loadProject, view]);
  useEffect(() => {
    if (bootstrap.status !== 'ready' || view !== 'activity' || !from || !to) return;
    return loadActivity();
  }, [bootstrap.status, loadActivity, view]);
  const openMilestone = useCallback((id: string) => {
    setMilestone(id); setMilestoneData({ status: 'loading' });
    api<MilestoneProgress>('milestone', `/api/milestone?${new URLSearchParams({ project, milestone: id })}`).then((data) => setMilestoneData({ status: 'ready', data })).catch((error: unknown) => { if (!(error instanceof DOMException && error.name === 'AbortError')) setMilestoneData({ status: 'error', message: error instanceof Error ? error.message : 'Could not load milestone details.' }); });
  }, [api, project]);
  const changeProject = useCallback((value: string) => {
    setProject(value); setMilestone(''); setMilestoneData(null);
  }, []);
  const reloadTeam = loadTeam;
  const reloadProject = loadProject;
  const reloadActivity = loadActivity;
  const loadMore = async () => {
    if (changes.status !== 'ready' || !changes.data.nextCursor || loadingMore) return;
    const generation = activityGeneration.current;
    const cursor = changes.data.nextCursor;
    setLoadingMore(true);
    setPaginationError(null);
    const query = new URLSearchParams({ from, to, limit: '30', cursor }); if (member) query.set('member', member); if (activityProject) query.set('project', activityProject);
    try {
      const next = await api<ChangesResult>('more', `/api/changes?${query}`);
      if (generation !== activityGeneration.current) return;
      setChanges((current) => generation === activityGeneration.current && current.status === 'ready' && current.data.nextCursor === cursor
        ? { status: 'ready', data: { ...next, changes: [...current.data.changes, ...next.changes] } }
        : current);
    } catch (error) {
      if (generation !== activityGeneration.current || (error instanceof DOMException && error.name === 'AbortError')) return;
      setPaginationError(error instanceof Error ? error.message : 'Could not load more activity.');
    } finally {
      if (generation === activityGeneration.current) setLoadingMore(false);
    }
  };
  const signInAgain = () => { location.assign('/app/'); };
  if (sessionExpired) return <ScreenState kind="session" message="Your session has ended." onSignIn={signInAgain}/>;
  if (bootstrap.status === 'loading') return <ScreenState kind="loading" message="Opening your workspace…" />;
  if (bootstrap.status === 'error') return <ScreenState kind={bootstrap.message.toLowerCase().includes('session') || bootstrap.message.toLowerCase().includes('unauthor') ? 'session' : 'error'} message={bootstrap.message} onRetry={loadBootstrap} onSignIn={signInAgain}/>;
  const info = bootstrap.data;
  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#/team" onClick={() => setView('team')}><span className="brand-mark"><Icon name="eye" size={21}/></span><span>linear<span className="brand-light">eye</span><small>TEAM INTELLIGENCE</small></span></a>
      <div className="workspace-label">WORKSPACE</div><div className="workspace-card"><span className="workspace-dot"/>{info.teams[0]?.name ?? 'Your workspace'}<Icon name="chevron" size={15}/></div>
      <nav className="main-nav" aria-label="Main navigation">
        {(['team', 'projects', 'activity'] as View[]).map((item) => <a key={item} href={`#/${item}`} className={`nav-item ${view === item ? 'active' : ''}`} onClick={() => setView(item)}><Icon name={item === 'team' ? 'team' : item === 'projects' ? 'project' : 'activity'}/><span>{item === 'team' ? 'Team' : item === 'projects' ? 'Projects' : 'Activity'}</span>{view === item && <i/>}</a>)}
      </nav>
      <div className="sidebar-bottom"><div className="sync-mini"><span className={`sync-check ${info.latestSync && info.latestSync.status !== 'completed' ? 'sync-pending' : ''}`}>{info.latestSync && info.latestSync.status !== 'completed' ? '·' : '✓'}</span><div><strong>{info.latestSync ? `${titleCase(info.latestSync.mode)} ${titleCase(info.latestSync.status)}` : 'Sync status unavailable'}</strong><small>Full {prettyDate(info.lastFullSyncCompletedAt, info.timezone)} · reconcile {prettyDate(info.lastReconcileCompletedAt, info.timezone)}</small></div></div><div className="profile"><span className="avatar">{info.viewer.email.slice(0, 1).toUpperCase()}</span><span className="profile-info"><strong>{info.viewer.email.split('@')[0]}</strong><small>{info.viewer.email}</small></span><a href="/cdn-cgi/access/logout" className="logout" aria-label="Sign out" title="Sign out">↗</a></div></div>
    </aside>
    <main className="main-content">
      <header className="topbar"><span className="topbar-kicker">LINEAR EYE <span>/</span> {view.toUpperCase()}</span><div className="topbar-right"><span className="timezone"><Icon name="calendar" size={15}/>{info.timezone}</span><a className="top-user" href="/cdn-cgi/access/logout" title="Sign out">{info.viewer.email}</a><a className="mobile-logout" href="/cdn-cgi/access/logout" aria-label="Sign out" title="Sign out"><Icon name="arrow" size={17}/></a></div></header>
      <div className="page-wrap">
        {view === 'team' && <TeamView info={info} selected={team} setSelected={setTeam} includeStale={includeStale} setIncludeStale={setIncludeStale} state={teamData} retry={reloadTeam}/>}
        {view === 'projects' && <ProjectsView info={info} selected={project} onProjectChange={changeProject} onOpenMilestone={openMilestone} state={projectData} milestone={milestone} milestoneData={milestoneData} retry={reloadProject}/>}
        {view === 'activity' && <ActivityView info={info} from={from} setFrom={setFrom} to={to} setTo={setTo} member={member} setMember={setMember} project={activityProject} setProject={setActivityProject} state={changes} retry={reloadActivity} loadMore={loadMore} loadingMore={loadingMore} paginationError={paginationError}/>}
      </div>
      <footer className="page-footer"><span>Read-only intelligence for your Linear workspace</span><span>Tracking since {prettyDate(info.trackingStartedAt, info.timezone)}</span></footer>
    </main>
    <nav className="mobile-nav" aria-label="Main navigation">{(['team', 'projects', 'activity'] as View[]).map((item) => <a key={item} href={`#/${item}`} className={view === item ? 'active' : ''} onClick={() => setView(item)}><Icon name={item === 'team' ? 'team' : item === 'projects' ? 'project' : 'activity'}/><span>{item === 'team' ? 'Team' : item === 'projects' ? 'Projects' : 'Activity'}</span></a>)}</nav>
  </div>;
}

function ScreenState({ kind, message, onRetry, onSignIn }: { kind: 'loading' | 'error' | 'session'; message: string; onRetry?: () => void; onSignIn?: () => void }) {
  return <main className="screen-state"><span className="state-mark"><Icon name="eye" size={24}/></span><div className="state-eyebrow">LINEAR EYE</div><h1>{kind === 'loading' ? 'Opening your workspace' : kind === 'session' ? 'Your session has ended' : 'We couldn’t load your workspace'}</h1><p>{kind === 'loading' ? message : kind === 'session' ? 'Sign in through your organization to continue.' : message}</p>{kind === 'loading' ? <span className="loader"/> : <div className="state-actions">{kind === 'session' ? <button className="button primary" onClick={onSignIn}>Sign in again <Icon name="arrow" size={15}/></button> : <button className="button primary" onClick={onRetry}><Icon name="refresh" size={15}/> Try again</button>}</div>}</main>;
}
function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) { return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action}</div>; }
function CoverageNote({ coverage, timezone }: { coverage: { complete: boolean; trackingStartedAt: string | null }; timezone: string }) {
  if (coverage.complete) return <div className="coverage good"><span>✓</span><div><strong>Full tracking coverage</strong><small>History has been collected since {prettyDate(coverage.trackingStartedAt, timezone)}.</small></div></div>;
  return <div className="coverage notice"><span>i</span><div><strong>Partial history</strong><small>Tracking began {prettyDate(coverage.trackingStartedAt, timezone)}. Earlier activity may be missing.</small></div></div>;
}
function Select({ label, value, onChange, options, placeholder, allowEmpty = false }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ id: string; name: string }>; placeholder: string; allowEmpty?: boolean }) {
  return <label className="select-field"><span>{label}</span><span className="select-control"><select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>{(allowEmpty || !value) && <option value="" disabled={!allowEmpty}>{placeholder}</option>}{options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select><Icon name="chevron" size={15}/></span></label>;
}
function ErrorPanel({ message, retry }: { message: string; retry: () => void }) { return <div className="error-panel"><span className="error-dot">!</span><div><strong>Something interrupted this view</strong><p>{message}</p></div><button className="button small" onClick={retry}><Icon name="refresh" size={14}/> Retry</button></div>; }
function LoadingPanel({ label = 'Loading your data…' }: { label?: string }) { return <div className="loading-panel"><span className="loader small-loader"/><span>{label}</span></div>; }

function TeamView({ info, selected, setSelected, includeStale, setIncludeStale, state, retry }: { info: Bootstrap; selected: string; setSelected: (value: string) => void; includeStale: boolean; setIncludeStale: (value: boolean) => void; state: LoadState<TeamWork>; retry: () => void }) {
  const issueCount = state.status === 'ready' ? state.data.members.reduce((sum, group) => sum + group.issues.length, 0) : 0;
  return <>
    <PageHeading eyebrow="PEOPLE & WORK" title="Team overview" description="A clear view of what’s moving, who owns it, and where work may need attention." action={<button className="button" onClick={retry}><Icon name="refresh" size={15}/> Refresh</button>}/>
    <div className="toolbar"><Select label="TEAM" value={selected} onChange={setSelected} options={info.teams} placeholder="All teams" allowEmpty/><label className="toggle"><input type="checkbox" checked={includeStale} onChange={(event) => setIncludeStale(event.target.checked)}/><span className="toggle-track"/><span>Include stale work</span><span className="help-tip" title="Stale work has had no activity for several days">?</span></label></div>
    {state.status === 'loading' ? <LoadingPanel label="Gathering the latest team work…"/> : state.status === 'error' ? <ErrorPanel message={state.message} retry={retry}/> : <>
      <div className="metric-row"><Metric label="People with active work" value={String(state.data.members.length).padStart(2, '0')} sub="Currently assigned"/><Metric label="Issues in progress" value={String(issueCount).padStart(2, '0')} sub={state.data.coverage.complete ? 'Complete tracking history' : 'History is still building'} accent/></div>
      <CoverageNote coverage={state.data.coverage} timezone={info.timezone}/>
      {state.data.members.length === 0 ? <EmptyState title="No active work to show" body="When issues are assigned in a started workflow state, they’ll appear here."/> : <div className="member-list">{state.data.members.map((group) => <section className="member-card" key={group.user.id}><header className="member-header"><div className="member-avatar">{(group.user.displayName || group.user.name).slice(0, 1).toUpperCase()}</div><div className="member-name"><strong>{group.user.displayName || group.user.name}</strong><small>{group.user.email || 'Team member'}</small></div><span className="count-pill">{plural(group.issues.length, 'issue')}</span></header><div className="issue-table"><div className="issue-table-head"><span>ISSUE</span><span>PROJECT</span><span>STATE</span><span>ACTIVITY</span></div>{group.issues.map((issue) => <div className="issue-row" key={issue.id}><div className="issue-main">{linkedIssue(issue)}</div><span className="project-cell">{issue.project ?? 'Unassigned'}</span><span><StatePill state={issue.state ?? 'In progress'}/></span><span className={`activity-cell ${issue.stale ? 'stale' : ''}`}>{issue.stale ? <><span className="stale-dot"/>Quiet {plural(issue.daysSinceActivity ?? 0, 'day')}</> : prettyDate(issue.lastActivityAt || issue.updatedAt, info.timezone)}</span></div>)}</div></section>)}</div>}
      <div className="data-footnote">Work shown as of {prettyDate(state.data.generatedAt, info.timezone, true)} <span>·</span> {state.data.coverage.complete ? 'All available history included' : `Tracking since ${prettyDate(state.data.coverage.trackingStartedAt, info.timezone)}`}</div>
    </>}
  </>;
}
function Metric({ label, value, sub, accent = false }: { label: string; value: string; sub: string; accent?: boolean }) { return <div className={`metric-card ${accent ? 'metric-accent' : ''}`}><span>{label}</span><strong>{value}</strong><small>{sub}</small></div>; }
function StatePill({ state }: { state: string }) { const lower = state.toLowerCase(); return <span className={`state-pill ${lower.includes('done') || lower.includes('complete') ? 'complete' : lower.includes('progress') ? 'progress' : ''}`}><i/>{state}</span>; }
function EmptyState({ title, body }: { title: string; body: string }) { return <div className="empty-state"><span className="empty-icon"><Icon name="eye" size={22}/></span><h3>{title}</h3><p>{body}</p></div>; }

function ProjectsView({ info, selected, onProjectChange, onOpenMilestone, state, milestone, milestoneData, retry }: { info: Bootstrap; selected: string; onProjectChange: (value: string) => void; onOpenMilestone: (id: string) => void; state: LoadState<ProjectProgress>; milestone: string; milestoneData: LoadState<MilestoneProgress> | null; retry: () => void }) {
  const active = state.status === 'ready' ? state.data : null;
  return <>
    <PageHeading eyebrow="DELIVERY & MOMENTUM" title="Project progress" description="See how work is moving across projects and milestones." action={<button className="button" onClick={retry}><Icon name="refresh" size={15}/> Refresh</button>}/>
    <div className="toolbar"><Select label="PROJECT" value={selected} onChange={onProjectChange} options={info.projects} placeholder="Choose a project"/>{active && <div className="toolbar-context"><span className="context-dot"/> Updated {prettyDate(active.generatedAt, info.timezone, true)}</div>}</div>
    {!selected && <EmptyState title="Choose a project to begin" body="Select a project above to explore its progress and milestones."/>}
    {state.status === 'loading' && selected && <LoadingPanel label="Calculating project progress…"/>}
    {state.status === 'error' && <ErrorPanel message={state.message} retry={retry}/>}
    {active && <>
      <CoverageNote coverage={active.coverage} timezone={info.timezone}/>
      <section className="project-summary"><div className="project-summary-top"><div><div className="eyebrow">PROJECT SNAPSHOT</div><h2>{active.project.name}</h2><span className="summary-caption">{plural(active.issueCount.total, 'tracked issue')} across active work</span></div><div className="project-percent">{percent(active.progress.byCount)}<small>complete</small></div></div><div className="progress-track"><i style={{ width: `${Math.max(0, Math.min(100, (active.progress.byCount ?? 0) * 100))}%` }}/></div><div className="progress-breakdown"><span><i className="dot done"/>{active.issueCount.completed} completed</span><span><i className="dot moving"/>{active.issueCount.started} in progress</span><span><i className="dot open"/>{active.issueCount.unstarted + active.issueCount.backlog} not started</span><span className="estimate-total">{active.estimates.completed} / {active.estimates.total} estimate points</span></div></section>
      <div className="section-heading"><div><div className="eyebrow">MILESTONES</div><h2>Project checkpoints</h2></div><span className="quiet-label">{active.milestones.length} total</span></div>
      {active.milestones.length === 0 ? <EmptyState title="No milestones yet" body="Milestones added to this project will appear here."/> : <div className="milestone-grid">{active.milestones.map((item) => <button className={`milestone-card ${milestone === item.milestone.id ? 'selected' : ''}`} key={item.milestone.id} onClick={() => onOpenMilestone(item.milestone.id)}><span className="milestone-card-head"><span className="milestone-symbol">◉</span><span className="milestone-date">{item.milestone.targetDate ? `Due ${prettyDate(item.milestone.targetDate, info.timezone)}` : 'No due date'}</span></span><strong>{item.milestone.name}</strong><span className="milestone-progress">{percent(item.progress.byCount)} <small>complete</small><span>{item.issueCount.completed} of {item.issueCount.total} issues</span></span><span className="tiny-progress"><i style={{ width: `${Math.max(0, Math.min(100, (item.progress.byCount ?? 0) * 100))}%` }}/></span></button>)}</div>}
      {milestoneData?.status === 'loading' && <LoadingPanel label="Opening milestone details…"/>}
      {milestoneData?.status === 'error' && <ErrorPanel message={milestoneData.message} retry={() => onOpenMilestone(milestone)}/>}
      {milestoneData?.status === 'ready' && <MilestoneDetail data={milestoneData.data} timezone={info.timezone}/>}
      <div className="data-footnote">Project progress calculated from the latest synced issue snapshot.</div>
    </>}
  </>;
}
function MilestoneDetail({ data, timezone }: { data: MilestoneProgress; timezone: string }) {
  const buckets = Object.entries(data.issues).filter(([, issues]) => issues.length > 0) as Array<[string, Issue[]]>;
  return <section className="milestone-detail"><header><div><div className="eyebrow">MILESTONE DETAIL</div><h2>{data.milestone.name}</h2></div><span className="detail-completion">{percent(data.progress.byCount)} complete</span></header><div className="detail-stats"><span>{plural(data.issueCount.total, 'issue')}</span><span>{data.estimates.completed} / {data.estimates.total} estimate points</span>{data.milestone.targetDate && <span>Target {prettyDate(data.milestone.targetDate, timezone)}</span>}</div>{buckets.length ? buckets.map(([bucket, issues]) => <div className="detail-bucket" key={bucket}><h3>{titleCase(bucket)} <small>{issues.length}</small></h3>{issues.map((issue) => <div className="detail-issue" key={issue.id}>{linkedIssue(issue)}<StatePill state={issue.state ?? titleCase(bucket)}/></div>)}</div>) : <p className="quiet-text">No issues are currently assigned to this milestone.</p>}</section>;
}

function ActivityView({ info, from, setFrom, to, setTo, member, setMember, project, setProject, state, retry, loadMore, loadingMore, paginationError }: { info: Bootstrap; from: string; setFrom: (value: string) => void; to: string; setTo: (value: string) => void; member: string; setMember: (value: string) => void; project: string; setProject: (value: string) => void; state: LoadState<ChangesResult>; retry: () => void; loadMore: () => void; loadingMore: boolean; paginationError: string | null }) {
  const rows = state.status === 'ready' ? state.data.changes : [];
  return <>
    <PageHeading eyebrow="OBSERVED HISTORY" title="Recent activity" description="A chronological record of changes observed in your Linear workspace." action={<button className="button" onClick={retry}><Icon name="refresh" size={15}/> Refresh</button>}/>
    <div className="filter-panel"><label className="date-field"><span>FROM</span><span className="date-input"><Icon name="calendar" size={15}/><input aria-label="From date" type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)}/></span></label><label className="date-field"><span>TO</span><span className="date-input"><Icon name="calendar" size={15}/><input aria-label="To date" type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)}/></span></label><Select label="MEMBER" value={member} onChange={setMember} options={info.members.map((person) => ({ id: person.id, name: person.displayName || person.name }))} placeholder="All members" allowEmpty/><Select label="PROJECT" value={project} onChange={setProject} options={info.projects} placeholder="All projects" allowEmpty/></div>
    {state.status === 'loading' && <LoadingPanel label="Searching observed changes…"/>}
    {state.status === 'error' && <ErrorPanel message={state.message} retry={retry}/>}
    {state.status === 'ready' && <>
      <CoverageNote coverage={state.data.coverage} timezone={info.timezone}/>
      <div className="activity-summary"><strong>{rows.length}</strong><span>{rows.length === 1 ? 'change' : 'changes'} found</span><span className="summary-divider"/><span>{prettyDate(from, info.timezone)} – {prettyDate(to, info.timezone)}</span><span className="activity-zone">{state.data.period.timezone}</span></div>
      {rows.length ? <div className="activity-list">{groupByDate(rows, info.timezone).map(([day, changes]) => <section className="activity-day" key={day}><div className="day-label"><span className="day-marker"/><span>{day}</span><small>{changes.length}</small></div><div className="day-changes">{changes.map((change) => <ChangeRow key={change.id} change={change} timezone={info.timezone}/>)}</div></section>)}</div> : <EmptyState title="No changes in this period" body="Try a wider date range or clear one of the filters."/>}
      {state.data.nextCursor && <div className="load-more-wrap">{paginationError && <p className="pagination-error" role="alert">{paginationError} Your loaded changes are still available.</p>}<button className="button" disabled={loadingMore} onClick={loadMore}>{loadingMore ? <><span className="loader mini-loader"/> Loading…</> : paginationError ? 'Retry loading more' : 'Load more changes'}</button></div>}
      <div className="data-footnote">Only recorded changes are shown. {state.data.coverage.complete ? 'Full history is available for this period.' : `History is available from ${prettyDate(state.data.coverage.trackingStartedAt, info.timezone)}.`}</div>
    </>}
  </>;
}
function groupByDate(changes: Change[], timezone: string): Array<[string, Change[]]> {
  const groups = new Map<string, Change[]>();
  changes.forEach((change) => { const label = prettyDate(change.occurredAt, timezone); const group = groups.get(label) ?? []; group.push(change); groups.set(label, group); });
  return [...groups.entries()];
}
function ChangeRow({ change, timezone }: { change: Change; timezone: string }) {
  const actor = change.actor?.name ?? 'A team member';
  const oldValue = displayValue(change.before); const newValue = displayValue(change.after);
  const url = trustedIssueUrl(change.issue.url);
  return <article className="change-row"><span className="change-icon"><Icon name={change.field === 'state' ? 'project' : change.field === 'assignee' ? 'team' : 'activity'} size={16}/></span><div className="change-copy"><p><strong>{actor}</strong> changed <strong>{titleCase(change.field)}</strong> on {url ? <a href={url} target="_blank" rel="noreferrer" className="inline-issue">{change.issue.identifier ?? 'Issue'}</a> : <span className="inline-issue">{change.issue.identifier ?? 'Issue'}</span>} <span className="change-title">{change.issue.title ?? ''}</span></p><div className="change-values"><span>{oldValue}</span><span className="value-arrow">→</span><strong>{newValue}</strong></div></div><time>{prettyTime(change.occurredAt, timezone)}</time></article>;
}
function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'None';
  if (typeof value === 'object') { const record = value as Record<string, unknown>; return String(record.name ?? record.identifier ?? record.id ?? 'Updated'); }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
