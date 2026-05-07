import 'dotenv/config';
import { google } from 'googleapis';
const oauth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
oauth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const cal = google.calendar({ version: 'v3', auth: oauth });
await cal.events.delete({ calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary', eventId: '2hj319fb3ees33tpsta4rrf5hg' });
console.log('test event deleted.');
