import { Hono } from 'hono';
import { channel as slack } from './channels/slack.ts';

const app = new Hono();

app.route('/channels/slack', slack.route());

export default app;
