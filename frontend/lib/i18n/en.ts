/**
 * en.ts — the SOURCE OF TRUTH dictionary (P2-1 i18n).
 *
 * Every translatable string on a converted surface lives here, keyed by
 * surface. Other locales (nl.ts; fr when its translation lands) are typed
 * `Dictionary` = the shape of THIS object, so a missing or extra key is a
 * COMPILE error — and since P1-7 the frontend type-check gates the deploy,
 * an incomplete translation cannot ship. That is the whole reason this is
 * a hand-rolled typed module and not an i18n library with string keys:
 * `t.login.signIn` is checked; `t('login.signIn')` is hoped.
 *
 * Rules:
 *  - No `as const`: literals must widen to `string` so translations can
 *    differ (a `Dictionary` of literal types would demand the English text).
 *  - Interpolations are FUNCTIONS returning strings — no template
 *    mini-language to parse, and the arguments are type-checked.
 *  - Brand and product names (Clarion, Observatory, Touch ID, …) are never
 *    translated. Locale names (langName) are written in their OWN language.
 */

const en = {
  langName: 'English',

  common: {
    loading: 'Loading…',
    language: 'Language',
  },

  nav: {
    // Keyed by NAV_ITEMS' `key` in IconRail.tsx — the rail looks labels up
    // here so the item list itself stays a plain, translatable-free config.
    items: {
      home: 'Home',
      ask: 'Ask',
      dashboards: 'Dashboards',
      investigate: 'Investigate',
      subjects: 'Subjects',
      notebooks: 'Notebooks',
      sources: 'Sources',
      grids: 'Your tables',
      build: 'Build',
      relations: 'Relations',
      catalog: 'Catalog',
      pipelines: 'Refresh',
      review: 'Suggestions',
      team: 'Team & roles',
      policies: 'Policies',
      'ai-usage': 'AI usage',
      features: 'Who sees what',
      tenants: 'Customers',
    },
    groups: {
      uncover: 'Uncover',
      studio: 'Studio',
      settings: 'Settings',
    },
    collapse: 'Collapse',
    collapseNav: 'Collapse navigation',
    expandNav: 'Expand navigation',
    pending: (n: number) => `${n} pending`,
    dragToResize: 'Drag to resize',
    primaryNav: 'Primary navigation',
  },

  topbar: {
    searchOrAsk: 'Search or ask…',
    searchAria: 'Search (Cmd+K)',
    accountMenuFor: (name: string) => `Account menu for ${name}`,
    you: 'you',
    account: 'Account',
    profile: 'Profile',
    signOut: 'Sign out',
  },

  palette: {
    placeholder: 'Search tables, columns, dashboards, or type a command…',
    searching: 'Searching…',
    noResults: 'No results.',
    askAiInstead: 'Ask AI instead →',
    navigate: 'navigate',
    select: 'select',
    close: 'close',
    ariaLabel: 'Command palette',
    // The role-aware quick actions, keyed by their ids in CommandPalette.tsx.
    actions: {
      ask: { title: 'Ask a question', subtitle: 'Get an answer in plain language' },
      dashboard: { title: 'Create a dashboard', subtitle: 'Describe a report, AI builds it' },
      subjects: { title: 'Subjects', subtitle: 'Everything your team can ask about' },
      catalog: { title: 'Browse the catalog', subtitle: 'Find & understand your data' },
      glossary: { title: 'Business glossary', subtitle: 'Shared terms & definitions' },
      connect: { title: 'Connect a source', subtitle: 'Studio · add a data source' },
      shared: { title: 'Shared data', subtitle: 'Studio · the lookups every topic slices by' },
      grids: { title: 'Your tables', subtitle: 'Studio · budgets, mappings & lists you keep in Clarion' },
      products: { title: 'Build workshop', subtitle: 'Studio · design a new topic' },
      suggestions: { title: 'Suggestions', subtitle: 'Studio · confirm AI proposals' },
      team: { title: 'Team & roles', subtitle: 'Settings · users & invites' },
    },
    // Chip on each search result, keyed by result type.
    types: {
      table: 'table',
      column: 'column',
      kpi: 'kpi',
      dashboard: 'dashboard',
      product: 'product',
      action: 'action',
    },
  },

  authArt: {
    // "Observatory · Est. 2025" is brand, not copy — it stays verbatim.
    tagline1: 'Where your business',
    tagline2: 'comes into focus.',
    // Only claims that are TRUE may stand here (the P0-4 SOC-2 lesson).
    trustLine: 'EU-hosted · AES-256 · GDPR erasure built in',
    terms: 'Terms',
    privacy: 'Privacy',
    subprocessors: 'Subprocessors',
  },

  login: {
    eyebrow: 'Sign in',
    title: 'Welcome back.',
    lede: 'Your workspace is one step away.',
    newTo: 'New to Clarion?',
    requestInvite: 'Request an invite →',
    workEmail: 'Work email',
    emailPlaceholder: 'you@company.com',
    password: 'Password',
    forgot: 'Forgot?',
    invalidCredentials: 'Invalid email or password.',
    confirmEmailFirst: 'Confirm your email address first — check your inbox for the link.',
    resendLink: 'Send a new verification link →',
    resendSending: 'Sending…',
    resendSent: 'Link sent — check your inbox',
    signIn: 'Sign in',
    signingIn: 'Signing in…',
    // Second factor
    webauthnPrompt: 'Use your security key, Touch ID, Windows Hello, or your saved passkey to sign in.',
    useSecurityKey: 'Use security key',
    waiting: 'Waiting…',
    useTotpInstead: 'Use an authenticator code instead →',
    useWebauthnInstead: 'Use security key instead →',
    mfaPrompt: 'Enter the 6-digit code from your authenticator app — or a backup code in XXXXX-XXXXX format.',
    code: 'Code',
    verify: 'Verify',
    verifying: 'Verifying…',
    invalidCode: 'Invalid code. Try again or use a backup code.',
    webauthnFailed: 'Could not sign in with security key',
    backToSignIn: 'Back to sign in',
  },

  register: {
    eyebrow: 'Create workspace',
    title: 'Start observing.',
    lede: "A workspace is your company's private view. Invite teammates after you connect your first source.",
    alreadyAccount: 'Already have an account?',
    signIn: 'Sign in',
    workspaceName: 'Workspace name',
    workspacePlaceholder: 'Acme BV',
    yourName: 'Your name',
    namePlaceholder: 'Jan Janssens',
    workEmail: 'Work email',
    emailPlaceholder: 'you@company.com',
    password: 'Password',
    passwordPlaceholder: 'Minimum 8 characters',
    confirmPassword: 'Confirm password',
    passwordsDontMatch: 'Passwords do not match.',
    passwordTooShort: 'Password must be at least 8 characters.',
    registrationFailed: 'Registration failed. Please try again.',
    createWorkspace: 'Create workspace',
    creatingWorkspace: 'Creating workspace…',
    // Check-your-inbox panel
    almostThere: 'Almost there',
    checkInbox: 'Check your inbox.',
    oneClickLeft: 'One click left before your workspace opens.',
    sentLinkBefore: 'We sent a confirmation link to',
    sentLinkAfter: '. Click it to activate your workspace, then sign in. The link is valid for 24 hours.',
    nothingArriving: 'Nothing arriving? Check your spam folder, or request a new link from the sign-in screen once you try to log in.',
    wrongAddress: 'Wrong address?',
    registerAgain: 'Register again',
  },

  subjects: {
    eyebrow: 'Uncover',
    title: 'Subjects',
    lede: 'Everything your team can ask about, in one place.',
    askPlaceholder: 'Ask anything, or jump to a subject…',
    ask: 'Ask',
    loadFailed: 'Could not load your subjects.',
    noneYet: 'No subjects yet.',
    createTopics: 'Create your topics',
    stillSettingUp: 'Your team is still setting things up.',
    sharedData: 'Shared data',
    sharedDataLede: 'The lookups every subject slices by — your customers, items, accounts and terms.',
    gettingReady: 'getting ready',
    waitingForData: 'waiting for data from your source',
    refreshed: (rel: string) => `refreshed ${rel}`,
  },
};

export default en;

/** The contract every locale must satisfy — see the header comment. */
export type Dictionary = typeof en;
