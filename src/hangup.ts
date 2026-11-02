import { RoomServiceClient } from 'livekit-server-sdk';

/**
 * Hangs up a call by deleting its LiveKit room, which disconnects every
 * participant including the SIP leg (Twilio drops the line, billing stops).
 * session.close() alone only stops the agent's audio: the caller would sit in
 * silence on an open line. Never throws.
 */
export async function deleteRoom(roomName: string): Promise<void> {
  try {
    const lkUrl = process.env['LIVEKIT_URL'];
    const lkKey = process.env['LIVEKIT_API_KEY'];
    const lkSecret = process.env['LIVEKIT_API_SECRET'];
    if (!lkUrl || !lkKey || !lkSecret) {
      console.warn(
        '[hangup] LIVEKIT_URL/KEY/SECRET missing — skipping deleteRoom (SIP call may stay open)',
      );
      return;
    }
    const httpUrl = lkUrl.replace(/^wss?:\/\//, (m) =>
      m === 'wss://' ? 'https://' : 'http://',
    );
    await new RoomServiceClient(httpUrl, lkKey, lkSecret).deleteRoom(roomName);
  } catch (e) {
    console.warn('[hangup] deleteRoom threw:', (e as Error).message);
  }
}
