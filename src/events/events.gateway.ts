import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { ConfigService } from '@nestjs/config';

@WebSocketGateway({
  cors: {
    origin: [process.env.CORS_ORIGIN || 'http://localhost:3000', '*'],
    credentials: true,
  },
  namespace: '/',
})
export class EventsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EventsGateway.name);

  constructor(private configService: ConfigService) {}

  async afterInit(server: Server) {
    const redisHost = this.configService.get<string>('REDIS_HOST') || 'localhost';
    const redisPort = this.configService.get<number>('REDIS_PORT') || 6379;
    const redisPassword = this.configService.get<string>('REDIS_PASSWORD');

    try {
      const pubClient = createClient({
        socket: {
          host: redisHost,
          port: redisPort,
        },
        password: redisPassword || undefined,
      });
      const subClient = pubClient.duplicate();

      await Promise.all([pubClient.connect(), subClient.connect()]);

      server.adapter(createAdapter(pubClient, subClient) as any);
      this.logger.log('Redis adapter configured successfully');
    } catch (error) {
      this.logger.warn('Redis not available, using default in-memory adapter');
    }
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('join:tenant')
  handleJoinTenant(client: Socket, tenantId: string) {
    client.join(`tenant:${tenantId}`);
    this.logger.log(`Client ${client.id} joined tenant room: ${tenantId}`);
  }

  @SubscribeMessage('join:conversation')
  handleJoinConversation(client: Socket, conversationId: string) {
    client.join(`conversation:${conversationId}`);
  }

  @SubscribeMessage('leave:conversation')
  handleLeaveConversation(client: Socket, conversationId: string) {
    client.leave(`conversation:${conversationId}`);
  }

  emitToTenant(tenantId: string, event: string, data: any) {
    this.server.to(`tenant:${tenantId}`).emit(event, data);
  }

  emitToConversation(conversationId: string, event: string, data: any) {
    this.server.to(`conversation:${conversationId}`).emit(event, data);
  }

  emitMessageReceived(tenantId: string, conversationId: string, message: any) {
    this.emitToTenant(tenantId, 'message.received', { conversationId, message });
    this.emitToConversation(conversationId, 'message.new', message);
  }

  emitConversationUpdated(tenantId: string, conversation: any) {
    this.emitToTenant(tenantId, 'conversation.updated', conversation);
  }

  emitLeadCreated(tenantId: string, lead: any) {
    this.emitToTenant(tenantId, 'lead.created', lead);
  }

  emitDealUpdated(tenantId: string, deal: any) {
    this.emitToTenant(tenantId, 'deal.updated', deal);
  }

  emitNotification(tenantId: string, notification: any) {
    this.emitToTenant(tenantId, 'notification', notification);
  }

  @SubscribeMessage('widget:join')
  handleWidgetJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { widgetId: string; visitorId: string },
  ) {
    const room = `widget:${data.widgetId}:${data.visitorId}`;
    client.join(room);
    this.logger.log(`Widget visitor ${data.visitorId} joined room: ${room}`);
    return { success: true, room };
  }

  @SubscribeMessage('widget:message')
  handleWidgetMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { widgetId: string; visitorId: string; message: string },
  ) {
    const room = `widget:${data.widgetId}:${data.visitorId}`;
    this.logger.log(`Widget message from ${data.visitorId}: ${data.message}`);
    return { success: true, messageId: Date.now().toString() };
  }

  @SubscribeMessage('admin:join:widget')
  handleAdminJoinWidget(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    client.join(`admin:conversation:${data.conversationId}`);
    this.logger.log(`Admin joined widget conversation: ${data.conversationId}`);
    return { success: true };
  }

  emitWidgetMessage(widgetId: string, visitorId: string, message: any) {
    const room = `widget:${widgetId}:${visitorId}`;
    this.server.to(room).emit('widget:message:new', message);
  }

  emitAdminMessage(conversationId: string, message: any) {
    this.server.to(`admin:conversation:${conversationId}`).emit('admin:message:new', message);
  }

  notifyWidgetVisitor(widgetId: string, visitorId: string, event: string, data: any) {
    const room = `widget:${widgetId}:${visitorId}`;
    this.server.to(room).emit(event, data);
  }

  emitWidgetMessageStatus(widgetId: string, visitorId: string, conversationId: string, status: string) {
    const room = `widget:${widgetId}:${visitorId}`;
    this.server.to(room).emit('widget:message:status', { conversationId, status });
    this.logger.log(`Emitted status ${status} to widget room: ${room}`);
  }
}
