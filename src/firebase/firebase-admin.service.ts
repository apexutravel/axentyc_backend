import { Injectable, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';

@Injectable()
export class FirebaseAdminService {
  private readonly logger = new Logger(FirebaseAdminService.name);
  private app: admin.app.App;

  constructor() {
    try {
      if (admin.apps.length > 0) {
        this.app = admin.apps[0]!;
        this.logger.log('Firebase Admin SDK reusing existing app');
      } else {
        this.app = admin.initializeApp({
          credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
          }),
        });
        this.logger.log('Firebase Admin SDK initialized successfully');
      }
    } catch (error) {
      this.logger.error('Failed to initialize Firebase Admin SDK:', error);
    }
  }

  async sendPushNotification(
    token: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<string | null> {
    try {
      const message: admin.messaging.Message = {
        notification: { title, body },
        data,
        token,
      };
      const response = await admin.messaging().send(message);
      this.logger.log(`[FCM] Message sent successfully: ${response}`);
      return response;
    } catch (error) {
      this.logger.error('[FCM] Error sending message:', error);
      return null;
    }
  }

  async sendToMultipleDevices(
    tokens: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<admin.messaging.BatchResponse> {
    try {
      const message: admin.messaging.MulticastMessage = {
        notification: { title, body },
        data,
        tokens,
      };
      const response = await admin.messaging().sendEachForMulticast(message);
      this.logger.log(
        `[FCM] Batch sent: ${response.successCount} success, ${response.failureCount} failed`,
      );
      return response;
    } catch (error) {
      this.logger.error('[FCM] Error sending batch:', error);
      throw error;
    }
  }

  async sendToTopic(
    topic: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<string> {
    try {
      const message: admin.messaging.Message = {
        notification: { title, body },
        data,
        topic,
      };
      const response = await admin.messaging().send(message);
      this.logger.log(`[FCM] Topic message sent: ${response}`);
      return response;
    } catch (error) {
      this.logger.error('[FCM] Error sending to topic:', error);
      throw error;
    }
  }
}
