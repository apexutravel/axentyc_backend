import { Types } from 'mongoose';
import { FacebookService } from './facebook.service';
import { AUTOMATION_EVENT } from '../automations/automation-events';
import { AutomationTrigger } from '../automations/entities/automation.entity';

describe('Facebook comment polling fallback', () => {
  it('emits the same message and automation events as a webhook', async () => {
    const tenantId = new Types.ObjectId().toString();
    const workspaceId = new Types.ObjectId();
    const conversationId = new Types.ObjectId();
    const contactId = new Types.ObjectId();
    const savedMessage = {
      _id: new Types.ObjectId(),
      content: 'precio por favor',
    };

    const MessageModel: any = jest.fn().mockImplementation(() => ({
      save: jest.fn().mockResolvedValue(savedMessage),
    }));
    MessageModel.findOne = jest.fn().mockResolvedValue(null);

    const conversationModel: any = {
      findByIdAndUpdate: jest.fn().mockResolvedValue(undefined),
    };
    const eventsGateway: any = {
      isConversationBeingViewed: jest.fn().mockReturnValue(false),
      emitMessageReceived: jest.fn(),
    };
    const bus: any = { emit: jest.fn() };
    const service = new FacebookService(
      {} as any,
      {} as any,
      conversationModel,
      MessageModel,
      {} as any,
      {} as any,
      eventsGateway,
      {} as any,
      bus,
    );

    (service as any).getOrCreateContact = jest.fn().mockResolvedValue({
      _id: contactId,
      name: 'Rosa',
    });
    (service as any).getOrCreateCommentConversation = jest
      .fn()
      .mockResolvedValue({
        _id: conversationId,
        workspaceId,
      });

    const account: any = {
      tenantId: new Types.ObjectId(tenantId),
      workspaceId,
      accessToken: 'token',
      pageId: 'page-1',
      accountName: 'Página',
    };
    const created = await (service as any).upsertFbCommentFromFetch(
      tenantId,
      account,
      'post-1',
      {
        id: 'comment-1',
        from: { id: 'person-1', name: 'Rosa' },
        message: 'precio por favor',
      },
    );

    expect(created).toBe(true);
    expect(eventsGateway.emitMessageReceived).toHaveBeenCalledWith(
      tenantId,
      conversationId.toString(),
      savedMessage,
      expect.objectContaining({ _id: contactId }),
    );
    expect(bus.emit).toHaveBeenCalledWith(AUTOMATION_EVENT, {
      trigger: AutomationTrigger.MESSAGE_RECEIVED,
      tenantId,
      workspaceId: workspaceId.toString(),
      conversationId: conversationId.toString(),
      contactId: contactId.toString(),
      channel: 'facebook',
      text: 'precio por favor',
    });
  });
});
