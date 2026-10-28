import {
  compatWrapper,
  convertLegacyRouteRef,
} from '@backstage/core-compat-api';
import {
  createFrontendModule,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';
import { AgentChatPage, awsGenAiPlugin } from '@aws/genai-plugin-for-backstage';
import ChatIcon from '@material-ui/icons/Chat';

/** Página /assistant/:agentName renderizando o AgentChatPage do plugin AWS genai. */
export const agentChatPage = PageBlueprint.make({
  name: 'agent-chat',
  params: {
    path: '/assistant/:agentName',
    title: 'Chat Assistant',
    icon: <ChatIcon />,
    routeRef: convertLegacyRouteRef(awsGenAiPlugin.routes.root),
    loader: async () => compatWrapper(<AgentChatPage />),
  },
});

export const genaiModule = createFrontendModule({
  pluginId: 'app',
  extensions: [agentChatPage],
});
