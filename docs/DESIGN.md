---
name: Family Faces
description: Current visual system for the Family Faces review app.
colors:
  paper: "#f1f2f5"
  card: "#ffffff"
  ink: "#15171c"
  muted: "#646a7a"
  line: "#e2e5eb"
  accent: "#2c4bd1"
  accent-ink: "#ffffff"
  accent-soft: "#e9edfc"
  stamp: "#f2683c"
  warn: "#d97706"
  danger: "#d4342c"
  chip: "#f1f2f5"
  photo-outline: "rgba(0,0,0,.1)"
  paper-dark: "#0e1014"
  card-dark: "#171a20"
  ink-dark: "#e9ebf1"
  muted-dark: "#8b91a1"
  line-dark: "#272b34"
  accent-dark: "#7d93f7"
  accent-ink-dark: "#0e1014"
  accent-soft-dark: "#1d2440"
  stamp-dark: "#ff8a5c"
  warn-dark: "#f0a640"
  danger-dark: "#f07167"
  chip-dark: "#20242c"
  photo-outline-dark: "rgba(255,255,255,.1)"
typography:
  display:
    fontFamily: '"Bricolage Grotesque", "Geist", system-ui, sans-serif'
    fontSize: "28px"
    fontWeight: 650
    lineHeight: 1.15
    letterSpacing: "-.02em"
  headline:
    fontFamily: '"Bricolage Grotesque", "Geist", system-ui, sans-serif'
    fontSize: "26px"
    fontWeight: 650
    lineHeight: "normal"
    letterSpacing: "-.01em"
  title:
    fontFamily: '"Bricolage Grotesque", "Geist", system-ui, sans-serif'
    fontSize: "20px"
    fontWeight: 650
    lineHeight: "normal"
    letterSpacing: "-.01em"
  body:
    fontFamily: '"Geist", system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: '"Geist", system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "13px"
    fontWeight: 500
    lineHeight: "normal"
  metadata:
    fontFamily: '"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace'
    fontSize: "12px"
    fontWeight: 500
    lineHeight: "normal"
  nav-label:
    fontFamily: '"Geist", system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "11px"
    fontWeight: 500
    lineHeight: "normal"
    letterSpacing: ".06em"
rounded:
  surface: "14px"
  pill: "99px"
  field: "10px"
  filter-field: "8px"
  photo-tile: "12px"
  thumbnail: "6px"
  nav: "9px"
  tree-card: "16px"
  page-frame: "18px"
  avatar: "50%"
spacing:
  "4": "4px"
  "8": "8px"
  "12": "12px"
  "16": "16px"
  "18": "18px"
  "24": "24px"
  "28": "28px"
components:
  button:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 14px"
    height: "34px"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.card}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 14px"
    height: "34px"
  button-danger:
    backgroundColor: "{colors.card}"
    textColor: "{colors.danger}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 14px"
    height: "34px"
  button-link:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    padding: "2px 0"
  name-input:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.field}"
    padding: "0 12px"
    height: "36px"
  chip:
    backgroundColor: "{colors.chip}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "5px 11px"
  chip-tagged:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "5px 11px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.nav}"
    padding: "7px 10px"
  nav-item-active:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.nav}"
    padding: "7px 10px"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    padding: "16px 18px 18px"
  person-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    padding: "18px 10px 12px"
  segmented-control:
    backgroundColor: "{colors.chip}"
    rounded: "{rounded.pill}"
    padding: "3px"
  upload-dialog:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    padding: "0"
    width: "min(1080px, calc(100vw - 32px))"
---

# Design System: Family Faces

## Overview

**Creative North Star: "Light table"**

The source names the current theme “light table.” The app places photos and face crops on a paper background, with card surfaces for work areas. Compact controls and small metadata keep the photos visible. The display font marks page titles and person names.

This file records the current CSS in `review.html` and `web/50-polish.css`. It also records the controls in `web/01-photo-gallery.js`, `web/02-people-filters.js`, `web/00-familysearch-upload.js`, `web/40-people.js`, `web/41-tree-view.js`, `web/42-people-matches.js`, `web/30-viewer.js`, and `web/53-familysearch-tags.js`. The existing-Memory tag panel also uses `web/53-familysearch-tags.css`. Face similarity uses `web/43-face-similarity.js` and `web/43-face-similarity.css`. It uses the final CSS rules after the earlier rules. It does not add product claims or a new design direction.

**Key Characteristics:**

- Paper background, card surfaces, and ink text.
- Bricolage Grotesque titles, Geist body text, and Geist Mono counts.
- Blue accent states and orange stamp details.
- Rounded surfaces, pill controls, and circular person images.
- Automatic light and dark color schemes.
- Desktop sidebar and horizontal mobile tabs.

## Colors

The palette uses neutral work surfaces, a blue accent for links and states, and an orange stamp color for selected metadata.

### Primary

- **Accent:** Links, active navigation icons, face selection, selected tags, and focus outlines. `accent-soft` fills selected chips and focus rings. `accent-ink` gives text contrast on accent face-box labels.
- **Ink action:** The current primary button uses ink for its fill and card for its text. Its hover fill mixes ink with accent. It does not use the earlier blue button fill in the stylesheet.

### Secondary

- **Stamp:** The warm detail in the logo, chip counts, photo tags, similarity scores, and photo-count numbers.

### Neutral

- **Paper:** Page background and map or tree work areas.
- **Card:** Main content, cards, dialogs, fields, and active navigation items.
- **Ink:** Main text and primary action fill.
- **Muted:** Help text, secondary metadata, and inactive navigation.
- **Line:** Borders, dividers, and progress tracks.
- **Chip:** Chip and segmented-control backgrounds.
- **Photo outline:** A low-contrast outline around source photos.

Warning and danger colors mark possible face mismatches, conflicts, errors, and destructive actions. Photo source badges use a dark translucent fill with white text so that they remain readable over the image.

The `-dark` entries record the values from `prefers-color-scheme: dark`. The CSS keeps the same role names and changes their values automatically. The frontmatter lists both sets because the format has no theme field. Selection uses the same value as accent through the source `--sel` property. The sidecar snippets use the source CSS properties so that the active color scheme can apply.

## Typography

**Display Font:** Bricolage Grotesque, with Geist and system sans-serif fallbacks.

**Body Font:** Geist, with system sans-serif fallbacks.

**Label/Mono Font:** Geist Mono, with system monospace fallbacks.

The display font marks the main hierarchy and person names. Body text stays compact. Monospace text separates counts, scores, years, and short photo tags from prose. Ordinary metadata text can remain in the body font.

### Hierarchy

- **Display:** Page title; the frontmatter records the current page heading.
- **Headline:** Person detail heading.
- **Title:** Section heading. The upload heading is larger (24px); the Gallery viewer heading is smaller (18px).
- **Body:** General text. Help text is slightly smaller (13.5px) with a more open line height (1.55).
- **Label:** Button and chip labels. People filter labels use a heavier weight (600).
- **Metadata:** Navigation counts use this role. Photo tags use smaller, heavier monospace text (11px, 600). Standard metadata uses body text (12.5px).
- **Navigation label:** Uppercase section labels with added letter spacing.

The existing-Memory tag panel uses body text for person-ID fields at a larger size (16px). This local size keeps IDs legible on mobile and does not change the general body role. Its heading uses the display font (16px, 600).

These are observed sizes. The source does not define a common type scale ratio.

## Layout

The desktop shell has a sidebar (236px) and a flexible content column. The sidebar stays at the top of the viewport and fills its height. Its navigation scrolls when needed. The content has a small outer inset. The heading and main area form one card frame, with larger corners than the smaller cards.

At the mobile shell breakpoint (820px), the columns become one column. The sidebar becomes a normal block. Navigation becomes a horizontally scrolling row. Navigation section labels and the face progress panel are hidden. The main content uses smaller side padding (16px).

Repeated gaps and padding use the steps in the frontmatter. Controls wrap when space is limited. Help text has a bounded line length; the People distance note permits a wider line (75ch).

The People list uses an automatic grid with a minimum card width (150px) and a gap (12px). Its filter grid uses three columns, two at 700px, and one at 430px. Fields remain at least 40px high.

Likely matches appear near the top of a person page, before its saved faces. The match grid uses a minimum column width (200px), limited to the available width. Its row and column gaps are (20px and 16px). Face crops are contained in a fixed-height frame (160px). Filters and action rows wrap. Captions can wrap anywhere; actions remain at least 40px high.

Face similarity has a bounded body width (1100px). On desktop, Reference person and Compare with form two equal columns aligned at the top, with a gap (16px). The comparison age window sits beside Reference ages, with a flexible window column, a reference column (240px), and a gap (20px). The window has internal padding (16px 20px). The expanded source and result filters use three equal columns. Results use flat, divided rows: person links, sample crops, and a score. The crop column ranges from (180px to 320px); the score column is (84px). Rows have vertical padding and gaps (16px).

At 700px or less, the person pickers and expanded filters stack, and the age window sits above Reference ages. The window padding decreases (12px). Earlier ages and Later ages share a row, with the age note below them. A result name and score share the first row; crops span the second row. Result gaps decrease (12px). Reference details, crop groups, and long person names can wrap.

The tree keeps its canvas and record panel. Its toolbar stays above the cards; fit and center actions use the space below that toolbar. At the mobile shell breakpoint (820px), Find in tree fills a row above a horizontally scrolling action row. A count sits at the bottom of the canvas. Expansion fits the visible branch so the added generation stays in view.

The Gallery uses an automatic grid with a minimum photo width (240px). Its row and column gaps differ (24px and 18px). At 600px, the Gallery uses one column and gives the person input the full row. Photo previews contain the whole image in a fixed frame (3:2).

The upload dialog uses two columns for the image and fields. At 700px or less, it uses one column and smaller padding (16px). It has a horizontal photo strip, a sticky header, and a sticky action footer. Photo checkboxes sit below their review buttons. The selected-photo list sits below the image and fields. Each row places its review button beside the title, confirmed names and IDs, and status. At 700px or less, these rows also use one column. Long titles, names, IDs, and status text can wrap. Both native dialogs leave a viewport margin (16px per side) and limit height to the viewport.

The existing-Memory tag panel sits below File in the current photo viewer. It keeps the viewer's desktop side panel and mobile layout, where the photo sits above the record panel at the mobile shell breakpoint (820px). A line divider and top padding (20px) separate the tag section. The People to tag fieldset has vertical margins (20px). Selection labels are at least (44px) high, face thumbnails are (40px) square, and ID fields and action buttons are at least 40px high. Names, links, and preview text can wrap.

## Elevation & Depth

The system uses borders and changes in surface color for most depth. Group cards have no shadow at rest. Active navigation items, sidebar status panels, active segmented buttons, and tree cards use the source surface shadow. Hovered person cards, import cards, and family branches use an accent border and a soft accent ring. Dialog backdrops reduce the visibility of the page behind them.

The sidecar records the light and dark surface shadows, the accent ring, and the floating feedback shadow. The full-photo modal also uses a blurred backdrop (6px). The native Gallery and upload dialogs use dark backdrops without that blur.

The toast has an opacity transition (0.3s). Tree center and focus actions use a short transform transition (0.24s). The source defines no general motion scale. Reduced motion disables transitions and animations.

## Shapes

Common cards and dialogs use the surface radius. Buttons, chips, segmented controls, toasts, and floating action bars use the pill radius. Name fields use the field radius. People filters use the smaller filter-field radius. Gallery photo buttons and face tiles use the photo-tile radius. Person images are circular.

Most surfaces have a thin border (1px). Face selection uses an inset outline (3px) and a check mark. Odd-face markers use a dashed warning border. Conflicts use a solid danger border. The ignored-person card keeps a dashed border.

## Components

### Buttons

Standard buttons have a card fill, ink text, and a line border. Primary buttons have an ink fill and card text. Danger buttons change the text color. Link buttons remove the border and fill and use smaller muted text. The People card Rename action becomes visible on hover or keyboard focus.

Buttons use a pill shape. The base button height is compact (34px). Gallery filter and page controls and upload controls use larger minimum heights (40px). Upload controls can grow when their text wraps. Hover changes the border or the primary fill. Keyboard focus uses an accent outline (2px) with an offset (2px). Disabled upload and page buttons use reduced opacity (0.5).

### Chips

Chips use a chip fill and a pill shape. Hover adds an accent border and soft accent fill. Tagged chips use the accent fill and text roles. Suggested chips use a card fill and line border. Small counts use the stamp color and monospace font.

### Cards / Containers

Group cards use the common surface radius and line border. Person cards use the same surface roles in a centered vertical layout. Their circular image or initials area has a card gap and line outline. Person names use the display font; photo counts use stamp-colored monospace text. Source counts and relationship distance use muted text below the name.

### Inputs / Fields

Name fields use card fill, ink text, a line border, and the field radius. Their focus state changes the border to accent and adds a soft accent ring. People and Gallery filter fields use an explicit accent focus outline. The People and upload input rules, and the Gallery control rule, set placeholder text to the muted role at full opacity. Upload text areas use the field radius and can resize vertically.

### Navigation

The sidebar has section labels and icon, label, and count rows. The active item has a card fill and surface shadow; its icon uses accent. Hover uses a faint neutral fill. Counts use the metadata font. On mobile, the same tabs form a horizontally scrolling row.

### Segmented controls

The outer control uses a chip fill and a pill shape. Each option is also a pill. The active option uses a card fill, ink text, and the surface shadow. Keyboard focus uses the common accent outline.

### Gallery

The Gallery places the person input, source selector, selected-person removal buttons, and AND/OR radio controls above the photo grid. Captions show a title, optional date, and linked people. FamilySearch photos have a source badge over the image. Photo buttons have a visible keyboard focus outline. Filter updates preserve keyboard focus. The native viewer shows the full image, its linked people, source details, position, and previous or next controls.

In the current photo viewer, Nobody else appears beside Name next unnamed face when unnamed faces remain. Both actions are at least 40px high. Help text explains that only the remaining unnamed faces are ignored and existing names stay. The action uses the current fonts, colors, pill buttons, and responsive layout. Save or cancel name, caption, and date drafts first. One ordered POST to `/api/label` uses `only_unnamed: true` and groups the changed faces under one Undo. While saving, face controls are disabled; repeated clicks, close, and photo navigation are blocked. Status shows errors or that no unnamed faces changed. Undo appears only for a returned History entry.

### Existing Memory tags

Tag in FamilySearch opens an inline panel below File when the photo has a saved Memory. The panel shows the Memory ID and Open Memory link, connection status, Connect or Reconnect FamilySearch, and Cancel sign-in during connection. It reuses the current fonts, colors, pill buttons, and name fields. The Memory link uses accent, an underline offset (3px), and a keyboard focus outline (2px) with an offset (4px).

Named faces start unchecked. Each selection row shows the viewer face number, face thumbnail, and name. A visible FamilySearch person ID label sits above an editable saved ID. Reload named faces updates this list after a face is named in the viewer. When no named faces are available, help text directs the user to the face list above.

Check selected tags reads the person records and existing Memory tags. Its read-only preview shows confirmed names, IDs, and Add face tag, Link existing tag to this person, or Already tagged for each selected person. Submit tags requires this check and an active connection. A change to a selection or ID clears the preview and requires another check. If all selected tags are already present, Submit tags stays disabled. Submission uses the saved Memory and sends no photo.

During a check or submission, all panel buttons, checkboxes, and ID fields are disabled, including Reload named faces. The panel has a busy state, and its open action cannot reset an active request. Status uses a polite live region; errors use danger. During submission, the viewer prevents close and photo navigation until the result arrives. The preview and result stay visible in the open panel after submission so the user can review them.

### People filters

Each filter has a visible label above the field. When hidden tag imports exist, a note below the grid gives their count and names the Photo source option that shows them. The source selector includes Hidden imports and All people, including hidden imports. All people keeps this group hidden. A distance note follows the grid. A count and Clear filters action follow that note. Loading, error, and empty messages use separate states. Source counts and family distance remain on each person card.

### People likely matches

Each result shows the strongest unnamed face from one photo not already linked to the person. The original face crop opens the full photo. Score and source share one row; the caption and Add match / Not this person actions follow it. Scores use tabular numbers. The controls reuse the current card, chip, ink, line, and accent roles.

Photo source and Minimum match score have visible labels. The browser saves both filters. Results are sorted by score and start with twelve items. Show N more adds the next twelve without replacing earlier items or stopping at one hundred. Loading, no reference face, no results, and error states have separate text. Errors offer Try again. Result updates use a polite live region.

A score does not confirm identity. Add match names the selected face; Not this person saves a rejection for that person. Both use the existing History and Undo actions. Busy states disable the section's buttons and fields. Filter updates keep focus on the field. After a saved choice, retry, or more-results action, focus returns to the section heading. Crop and filter focus outlines use accent (2px) with a larger offset (3px).

### Face similarity

Face similarity appears as a full tool under Explore. Named People and Portraits pages show the same controls in a native details section, closed on first entry. Its summary uses the display font (18px, 600) and includes a short age-comparison note. Open full tool keeps the chosen reference person. Reference person and Compare with have visible labels and use the saved name list. Compare with accepts one exact saved name; an empty field compares everyone else.

Comparison age window groups the current range, Window width, a native slider, Earlier ages, and Later ages. The window output uses the metadata font (22px, 600) and tabular numbers. Width choices are 1, 3, 5, 10, 20, or 40 years, or All ages. The slider moves the range by one year. Earlier ages and Later ages move by one full window width and stop at the bounds. All ages covers known ages from 0 to 120 and disables the slider and step buttons. The age note stays near these controls. Reference ages independently selects All known ages, Same comparison window, or Custom range. The two custom age fields appear only for Custom range.

Photo source and result filters stay in a separate native details section. It contains Photo source, FamilySearch branch, Face quality, Minimum faces per result, Minimum similarity, and Include hidden imports. Source and quality apply to both sides. The branch limits FamilySearch faces and is disabled for Album photos. Defaults use album photos, clear front-on faces, a ten-year window from age zero, all known reference ages, Mom's side for FamilySearch, one face per result, zero minimum similarity, and no hidden imports. The browser saves the controls. Reset filters keeps the reference person and restores these defaults.

Fields use the body font at a local larger size (16px), card fill, ink text, a line border, and field corners (10px). Fields, the native slider, action buttons, and checkbox labels have a minimum height (44px). Keyboard focus uses an accent outline (2px) with an offset (3px). Disabled buttons, inputs, and selects use reduced opacity (0.5) and the default cursor. A disabled action keeps its resting fill, border, and text on hover.

The reference row shows its name, selected age range, faces used, and sample crops. Results are ranked by highest similarity and load twelve at a time. Show N more appends the next results and shows the loaded and total counts. Each flat result row has a person link to People, a faces-used count, a Portraits link, sample crops, and a score. Names use the display font (17px, 600); scores use the metadata font (22px, 600) and the current readable stamp text role. Each crop is (72px by 80px), with thumbnail corners (6px), its estimated age, and its photo source below. The crop opens the full photo and has an accessible name that includes the person, estimated age, and source.

The age note identifies ages as estimates. Faces without a known age, including pending estimates, are excluded. The score note states that similarity is not an identity probability or proof of a family relationship. Comparison uses normalized averages of saved face vectors, one crop per photo, and at most 150 crops per person. The clearest saved crops are used first. This view only reads local records; it does not name faces or send photos.

Choose a reference person, an invalid saved name, loading, no reference faces, no results, and request errors have separate status text. Status uses a polite live region. No-reference and empty messages suggest relevant filter changes; errors offer Try again. A filter change clears the old samples and results and cancels the earlier request. Only the current request can paint results. Fields remain available during comparison; Show N more is disabled during its request. Results mark their busy state.

### Nearby family tree

The first view shows the branch person, direct parents, direct children, and partners. Cards keep the current tree-card radius, card fill, line border, circular image, display name, and monospace years. The selected card keeps its accent border and soft accent ring. Its name and image form a keyboard-accessible button with a pressed state.

Parents +N and Children +N sit below the card name and years. They appear only when that card has relatives not yet shown. Each action shows one more generation and those relatives' partners. The action uses chip fill, ink text, a line border, small field corners (8px), and a minimum height (40px). Expansion fits the visible branch and restores focus to the same card button. Single-parent lines attach to the rendered card's bottom edge, including its expansion controls.

Find in tree, relative-name buttons, and Focus tree here start a nearby view from the chosen person. Reset branch restores the direct relatives of the branch person. Show all N people and Show nearby family share one toggle with a pressed state. Fit visible tree and Center on selected retain their separate actions. The visible count uses a polite live region. Existing drag and relationship edit actions remain available. Card and expansion-button focus use the common accent outline (2px) and offset (2px).

### Upload dialog

The native dialog uses the current surface radius and color roles. Its image strip marks the photo under review with an accent border. A separate checkbox below each image controls whether that photo joins the queue. The strip uses a soft accent fill on hover and a visible accent outline on keyboard focus. Its scrollbars use muted thumbs on the card background.

Numbered face boxes use accent borders and labels. Each tag row has a face thumbnail, checkbox, person name, visible person-ID label, and confirmed record text. Saved-ID faces are selected by default. Each photo keeps its title, description, face choices, and entered IDs while the user moves between photos in the open dialog.

Each photo-strip item also shows its saved state: Not sent, Already uploaded, Photo uploaded · finish tags, or Upload recorded · check FamilySearch. Open Memory appears when a saved link is available. The status uses muted text below the checkbox; the link uses accent, a minimum height (40px), and the common keyboard focus outline. Saved completed drafts and saved drafts without a known Memory have read-only fields and are skipped by the queue. A known Memory with unconfirmed tags remains available for Finish tags.

The Selected photos list shows each checked photo's title, confirmed names and IDs, status, Review photo action, and Memory link when available. Dividers separate the rows. Help and status text use the muted role; errors use danger. Memory links use accent and have a visible keyboard focus outline.

The footer keeps the status, preview check, primary action, and Stop after this photo action together. Action labels show the photo count. A check reads records before upload. A change to a photo's fields or tags disables its upload until the next check. The queue sends one photo at a time. The stop action waits for the current request. Partial or unknown results stop the queue without an automatic retry. An existing Memory with unconfirmed tags changes the primary action to Finish tags.

Busy states disable editing and Close. Status text uses a polite live region, and the dialog marks its busy state. Close and Escape return focus to the opening control; closing is blocked while a request is active. These controls preserve the current visual system and user photos.

## Do's and Don'ts

### Do:

- **Do** reuse the current paper, card, ink, accent, and stamp roles.
- **Do** use the current display, body, and metadata font families.
- **Do** keep the current surface corners, pill controls, and automatic color schemes.
- **Do** keep visible field labels, the scoped placeholder rules, and accent keyboard focus states.
- **Do** retain the sidebar and its horizontal mobile tabs.
- **Do** keep the Gallery image contained so that the whole photo is visible.

### Don't:

- **Don't** replace the current visual identity as part of a local control addition.
- **Don't** apply the earlier CSS button or card styles when a later theme rule replaces them.
- **Don't** turn the preview check into the upload action.
- **Don't** remove the source and relationship context from the People filters.
