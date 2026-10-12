# Workbench theme

The sidebar brand name is 「无相之瞳」, paired with the radar-eye mark.

Applies the blue-and-white palette and a monochrome radar-eye mark to the sidebar (expanded and collapsed) and conversation welcome screen. The mark is a simplified vector redraw of the supplied neon eye, with a transparent background and no embedded raster data.

Edit `assets/radar-eye.svg`, then run `npm run build` to regenerate the shipped host and client bundles. The client uses the renderer's brand slots at priority -10 to override the default mark and inherits the theme's primary text color. React is supplied by the browser module loader.
