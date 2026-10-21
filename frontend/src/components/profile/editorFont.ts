import { DM_Sans } from 'next/font/google';

/**
 * The profile editor's typeface: DM Sans, the geometric sans the FlowCV
 * editor this one follows is set in. Self-hosted by next/font at build time,
 * as Geist is in the root layout, and exposed only as `--font-editor`, which
 * the editor's own stylesheet reads - so the shell around the editor stays in
 * Geist and no other page changes.
 *
 * The Add content dialog is portalled out of the editor, so it applies the
 * variable to itself as well.
 */
export const editorFont = DM_Sans({
  subsets: ['latin'],
  variable: '--font-editor',
  display: 'swap',
});
