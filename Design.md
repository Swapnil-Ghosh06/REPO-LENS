# RepoLens — Design Specification

**Version:** 2.0
**Principle:** This is a tool for developers. It should look like something engineers built for themselves — not a marketing page, not a SaaS dashboard, not a Chrome extension template. Functional, precise, trustworthy. It lives on GitHub and must feel like it belongs there.

---

## Design Philosophy

**Anti-patterns — never do these:**
- Gradient backgrounds or gradient buttons
- Drop shadows with color or glow
- Oversized padding that makes it feel like a landing page
- Emojis in UI (user messages only)
- Skeleton loaders with pulse animations
- Frosted glass (`backdrop-filter: blur(...)`)
- Any font other than Inter (UI) or JetBrains Mono (code)
- Rounded-everything aesthetic (panel edges are flush, not rounded)
- Box shadows on the panel itself
- Color themes or dark/light toggle

**What to aim for:**
- GitHub's own dark mode palette, extended — so the panel feels *native* to GitHub
- Every pixel has a job
- Information density is high, but breathing room is deliberate
- Monospace where it matters: file paths, code, line numbers, percentages

---

## Color System

All colors match GitHub's dark mode. These are the exact hex values. Do not substitute.

| Token | Hex | Usage |
|---|---|---|
| `--bg-primary` | `#0d1117` | Main panel background |
| `--bg-surface` | `#161b22` | Message bubbles, cards, code blocks |
| `--bg-hover` | `#1c2128` | Hover states |
| `--border` | `#30363d` | All borders, dividers |
| `--border-muted` | `#21262d` | Subtle separators |
| `--text-primary` | `#e6edf3` | Main body text |
| `--text-secondary` | `#8b949e` | Labels, metadata, timestamps |
| `--text-muted` | `#484f58` | Placeholder text, dim info |
| `--accent` | `#58a6ff` | Links, active states, citation chips |
| `--accent-hover` | `#79c0ff` | Accent hover state |
| `--success` | `#3fb950` | Indexed status dot, done state |
| `--warning` | `#d29922` | Indexing status dot, partial states |
| `--error` | `#f85149` | Error messages, error state |
| `--code-bg` | `#1c2128` | Code block backgrounds |
| `--user-bubble` | `#1f3244` | User message bubble background |
| `--user-border` | `#30478c` | User message bubble border |

---

## Typography

```css
/* UI text — headings, labels, messages, buttons */
font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;

/* Code, file paths, line numbers, percentages */
font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
```

| Element | Font | Size | Weight | Color |
|---|---|---|---|---|
| Panel header (repo name) | Inter | 13px | 600 | `--text-primary` |
| Body text / messages | Inter | 13px | 400 | `--text-primary` |
| Secondary labels | Inter | 11px | 400 | `--text-secondary` |
| Code blocks | JetBrains Mono | 12px | 400 | `--text-primary` |
| File citations | JetBrains Mono | 11px | 500 | `--accent` |
| Line numbers | JetBrains Mono | 11px | 400 | `--text-muted` |
| Progress percentage | Inter | 12px | 600 | `--text-primary` |
| Buttons | Inter | 12px | 500 | varies |
| Current file ticker | JetBrains Mono | 11px | 400 | `--text-muted` |
| Elapsed time | JetBrains Mono | 11px | 400 | `--text-muted` |

---

## Panel Layout

```
┌─────────────────────────────┐  ← 380px wide, 100vh height
│  HEADER                     │  ← 48px
│  ● RepoLens  owner/repo  ×  │     status dot + title + close button
├─────────────────────────────┤
│                             │
│  CONTENT AREA               │  ← fills remaining space, state-dependent
│                             │
├─────────────────────────────┤
│  INPUT BAR (READY only)     │  ← 56px, only in READY state
│  [Ask about this codebase…] [→] │
└─────────────────────────────┘
```

**Panel CSS:**
```css
#rl-container {
  all: initial;  /* isolate from GitHub's CSS */
  position: fixed;
  top: 0;
  right: 0;
  width: 380px;
  height: 100vh;
  z-index: 999999;
  background: var(--bg-primary);
  border-left: 1px solid var(--border);
  font-family: 'Inter', -apple-system, sans-serif;
  display: flex;
  flex-direction: column;
  transform: translateX(100%);
  transition: transform 0.2s ease-out;
}

#rl-container.open {
  transform: translateX(0);
}
```

No box-shadow. No border-radius on the panel. Flush with screen edges.

---

## Component Specs

### Trigger Button (floating, bottom-right of GitHub page)

```css
#rl-trigger {
  position: fixed;
  bottom: 24px;
  right: 24px;
  width: 40px;
  height: 40px;
  border-radius: 8px;
  background: #161b22;
  border: 1px solid #30363d;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 999998;
}

#rl-trigger:hover {
  background: #1c2128;
  border-color: #58a6ff;
}
```

Icon: `</>` text in `#8b949e`, 13px JetBrains Mono. NOT a chat bubble. NOT a sparkle. NOT a robot.

---

### Header

```
Height:        48px
Padding:       0 16px
Border-bottom: 1px solid #30363d
Layout:        flex, space-between, align-center

Left:   status dot (8px circle) gap-8 "RepoLens" (#8b949e, 12px) "/" repo-name (#e6edf3, 13px, truncated, max-width 200px)
Right:  × close button, 24×24px tap target, color #8b949e, hover #e6edf3
```

Status dot colors:
- `#484f58` (muted gray): NOT_INDEXED
- `#d29922` (warning orange): INDEXING
- `#3fb950` (success green): READY
- `#f85149` (error red): BACKEND_OFFLINE

---

### State: NOT_INDEXED

```
Padding:    24px 20px
Layout:     flex column, gap 16px

Repo name:  15px, 600 weight, #e6edf3
Desc:       "This repository hasn't been indexed yet." 12px, #8b949e
Metadata:   "~{N} files · est. {X} min" — JetBrains Mono 11px, #8b949e

Index button:
  width: 100%
  height: 36px
  border-radius: 6px
  background: #238636     ← GitHub's green, PRIMARY action
  color: white
  font: Inter 13px 500
  border: 1px solid rgba(240,246,252,0.1)
  cursor: pointer
  hover background: #2ea043
```

---

### State: INDEXING

```
Padding:    24px 20px
Layout:     flex column, gap 12px

Label:      "Indexing repository..." 13px, #8b949e

Progress bar track:
  height: 4px        ← thin, not fat
  background: #30363d
  border-radius: 2px

Progress bar fill:
  background: #58a6ff
  transition: width 0.3s ease-out

Stats row:
  left:  "{X} / {Y} files"  JetBrains Mono 11px, #8b949e
  right: "{N}%"             Inter 12px 600, #e6edf3

Current file:
  font:     JetBrains Mono 11px, #484f58
  overflow: hidden
  text-overflow: ellipsis
  white-space: nowrap
  prefix:   "↳ " in same color
  max-width: 100%

Elapsed time:
  "Elapsed: {M}:{SS}"  JetBrains Mono 11px, #484f58
  Update every second
```

---

### State: READY — Chat Interface

**Message area:**
```css
#rl-messages {
  flex: 1;
  overflow-y: auto;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
  scrollbar-width: thin;
  scrollbar-color: #30363d transparent;
}
```

**User message:**
```css
.rl-message-user {
  margin: 8px 16px 8px auto;
  max-width: 88%;
  padding: 8px 12px;
  background: #1f3244;
  border: 1px solid #30478c;
  border-radius: 8px 8px 2px 8px;
  font: 13px Inter, sans-serif;
  color: #e6edf3;
  line-height: 1.5;
}
```

**Assistant message:**
```css
.rl-message-assistant {
  margin: 8px 16px;
  max-width: 100%;
  padding: 0;
  font: 13px Inter, sans-serif;
  color: #e6edf3;
  line-height: 1.6;
  /* no bubble — text flows directly */
}

.rl-message-assistant code {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  background: #1c2128;
  padding: 1px 4px;
  border-radius: 3px;
}

.rl-message-assistant pre {
  background: #1c2128;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 12px;
  overflow-x: auto;
}

.rl-message-assistant pre code {
  background: none;
  padding: 0;
}
```

**Citation chips (below each assistant message):**
```css
.rl-citations {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 16px 12px;
}

.rl-citation-chip {
  font: 500 11px 'JetBrains Mono', monospace;
  color: #58a6ff;
  background: rgba(88, 166, 255, 0.08);
  border: 1px solid rgba(88, 166, 255, 0.2);
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
  text-decoration: none;
  transition: none;
}

.rl-citation-chip:hover {
  background: rgba(88, 166, 255, 0.15);
  border-color: rgba(88, 166, 255, 0.4);
}
```

**Streaming cursor:**
```css
.rl-cursor {
  display: inline-block;
  width: 2px;
  height: 14px;
  background: #8b949e;
  vertical-align: middle;
  animation: blink 0.8s step-end infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
```

No spinner. No loading bar. The streaming text IS the indicator.

---

### Input Bar

```css
#rl-input-bar {
  height: 56px;
  padding: 8px 12px;
  border-top: 1px solid #30363d;
  background: #0d1117;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

#rl-input {
  flex: 1;
  resize: none;
  height: 36px;
  max-height: 120px;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 8px 12px;
  font: 13px Inter, sans-serif;
  color: #e6edf3;
  outline: none;
  overflow-y: auto;
}

#rl-input:focus {
  border-color: #58a6ff;
}

#rl-input::placeholder {
  color: #484f58;
}

#rl-send {
  width: 36px;
  height: 36px;
  background: transparent;
  border: none;
  color: #58a6ff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

#rl-send:disabled {
  color: #484f58;
  cursor: default;
}
```

Send button icon: → arrow SVG, 16px. Not a paper plane. Not a ✈.

---

### State: BACKEND_OFFLINE

```
Padding:    24px 20px
Layout:     flex column, gap 16px

Icon:       ⚠ warning, 24px, #d29922

Heading:    "Backend not running"  14px 600 #e6edf3

Body:       "Start the RepoLens backend to use this extension."
            12px, #8b949e

Code block:
  background: #1c2128
  border: 1px solid #30363d
  border-radius: 6px
  padding: 12px 16px
  font: JetBrains Mono 12px, #e6edf3
  content: "uvicorn main:app --reload"

Copy button:
  Below code block
  12px, #58a6ff, no background, underline on hover
  text: "Copy command"
  On click: copies to clipboard, text changes to "Copied!" for 2 seconds
```

---

## Transitions

**Panel open/close (only approved animation):**
```css
transform: translateX(100%);  /* closed */
transform: translateX(0);     /* open */
transition: transform 0.2s ease-out;
```

**Message appearance:**
```css
.rl-message {
  opacity: 0;
  animation: fadeIn 0.15s ease forwards;
}
@keyframes fadeIn { to { opacity: 1; } }
```

**Progress bar:**
```css
transition: width 0.3s ease-out;
```

**State transitions:** Instant. No cross-fades between states.

---

## What Not to Build

- No dark/light mode toggle (dark only)
- No settings panel in v1
- No onboarding tooltips or overlays
- No success animations when indexing completes — just transition to READY
- No placeholder "suggested questions" bubbles
- No confetti, particle effects, or celebration UI
- No chat avatars or user icons
- No "powered by" branding inside the panel
- No loading skeletons with pulse animations
