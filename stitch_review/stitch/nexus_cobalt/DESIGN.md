# Design System Specification: The Architectural Intelligence

## 1. Overview & Creative North Star
**Creative North Star: "The Digital Obsidian"**

This design system moves away from the "SaaS-standard" look of white boxes and heavy borders. Instead, it draws inspiration from high-end architectural glazing and precision instrumentation. It is designed to feel like a high-performance engine room—silent, powerful, and impeccably organized.

We achieve a "High-End Editorial" feel by rejecting the traditional grid in favor of **Tonal Architecture**. This means depth is communicated through light and material density rather than lines. The result is an interface that feels less like software and more like a bespoke data-rich dashboard found in a modern command center.

---

2. Colors & Surface Logic

### The "No-Line" Rule
**Borders are a failure of hierarchy.** In this system, 1px solid borders are strictly prohibited for sectioning content. To define boundaries, use **Color Shifting**. A section is defined by a transition from `surface` (#f8f9ff) to `surface-container-low` (#eff4ff). This creates a "soft-edge" layout that reduces cognitive noise and allows data to breathe.

### Surface Hierarchy & Nesting
Treat the UI as a series of physical layers. Use the following tiers to define importance:
*   **Base Layer:** `surface` (#f8f9ff) - The canvas of the application.
*   **Secondary Context:** `surface-container-low` (#eff4ff) - For sidebars and navigation backgrounds.
*   **Active Content:** `surface-container-highest` (#d5e3fd) - For the most prominent interactive modules.
*   **Elevated Elements:** `surface-container-lowest` (#ffffff) - Reserved for cards or modals that need to "pop" off a tinted background.

### The "Glass & Gradient" Rule
To elevate the AI-powered nature of the platform, use Glassmorphism for floating panels.
*   **Implementation:** Use a background of `surface_variant` at 60% opacity with a `24px` backdrop-blur.
*   **Signature Gradients:** For primary CTAs and Hero moments, blend `primary` (#003358) into `primary_container` (#004a7c) at a 135-degree angle. This creates a "deep-sea" tonal shift that feels more premium than flat color fills.

---

## 3. Typography: Editorial Authority

We use a dual-font strategy to balance character with utility.

*   **Display & Headline (Manrope):** Chosen for its geometric precision. Use `display-lg` (3.5rem) with tighter letter-spacing (-0.02em) for high-impact data summaries. This conveys the "Intelligent" and "Modern" aspects of the brand.
*   **Body & Labels (Inter):** The industry standard for readability. Use `body-md` (0.875rem) for most data density scenarios.
*   **Hierarchy Note:** To achieve the "Editorial" look, favor large contrasts in scale. Don't be afraid to pair a `headline-lg` title with `label-sm` metadata to create a sense of sophisticated information architecture.

---

## 4. Elevation & Depth

### The Layering Principle
Depth is achieved through **Tonal Layering**. If you need to separate a card from the background, do not add a shadow first—change the background color. 
*   Place a `surface-container-lowest` (#ffffff) card on top of a `surface-container` (#e6eeff) background. The contrast provides all the "lift" required.

### Ambient Shadows
Shadows are used only for "active" floating elements (modals, dropdowns). 
*   **Spec:** `0px 12px 32px rgba(13, 28, 47, 0.06)`. 
*   The shadow color is derived from `on_surface` (#0d1c2f), ensuring it looks like natural ambient light rather than a dirty grey smudge.

### The "Ghost Border" Fallback
If accessibility requirements demand a stroke, use a **Ghost Border**:
*   **Spec:** `1px solid` using `outline_variant` at **15% opacity**. It should be felt, not seen.

---

## 5. Components

### Buttons
*   **Primary:** Uses the Primary-to-Container gradient. Corner radius: `md` (0.375rem).
*   **Secondary:** No background fill. Uses `primary` text and a "Ghost Border."
*   **States:** On hover, primary buttons should shift +10% in brightness, never change size.

### Data Chips
*   **Style:** Use `secondary_container` (#8fdfff) with `on_secondary_container` (#00647d) text.
*   **Shape:** Always `full` (9999px) roundedness to contrast against the more structured `md` corners of cards and buttons.

### Input Fields
*   **Style:** `surface_container_lowest` fill with a `sm` (0.125rem) bottom-only accent in `primary`.
*   **Focus:** Transition the bottom accent to `secondary` (#006781) with a soft outer glow of the same color at 10% opacity.

### Cards & Lists (The "No Divider" Rule)
Forbid the use of horizontal lines to separate list items. Instead:
1.  Increase vertical white space using the `1.5rem` spacing token.
2.  Use alternating subtle fills (`surface` vs `surface-container-low`) for striped rows in heavy data tables.

### AI Suggestion Modules
A custom component for this platform: Use a semi-transparent `tertiary_container` (#3424cc) background with a `2px` left-border of `tertiary` (#1d00a7) to indicate AI-generated insights.

---

## 6. Do's and Don'ts

### Do:
*   **Do** use asymmetrical layouts. A heavy left-aligned headline paired with a wide-spanning data visualization creates a modern, custom feel.
*   **Do** use `surface_dim` (#ccdbf4) for footer areas to ground the page.
*   **Do** prioritize data density by using `label-md` for secondary metadata.

### Don't:
*   **Don't** use pure black (#000000) for text. Always use `on_surface` (#0d1c2f) to maintain the sophisticated deep blue palette.
*   **Don't** use standard 1px borders to separate navigation from content. Use a subtle background shift instead.
*   **Don't** use high-saturation "alert" colors for non-critical information. Keep the palette restrained to teals and blues unless there is a genuine system error.