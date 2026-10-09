/**
 * /hots/catch-up/changes.json: the compact patch history (class A: our own summaries of
 * Blizzard's notes) that the catch-up island fetches when the visitor picks another date.
 * Static at build time; the default view is already rendered into the page.
 */
import type { APIRoute } from 'astro';
import { catchUpData } from '../../../games/hots/components/pagedata.ts';

export const GET: APIRoute = () =>
  new Response(JSON.stringify(catchUpData()), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
