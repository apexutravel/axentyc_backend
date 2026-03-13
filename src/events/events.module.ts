import { Module, Global } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { EventsGateway } from './events.gateway';

@Global()
@Module({
  imports: [EventEmitterModule.forRoot()],
  providers: [EventsGateway],
  exports: [EventsGateway],
})
export class EventsModule {}
