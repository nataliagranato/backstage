import { createApp } from '@backstage/frontend-defaults';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import { navModule } from './modules/nav';
import { homeModule } from './modules/home';
import awsOpsModule from './modules/aws-ops';

export default createApp({
  features: [catalogPlugin, navModule, homeModule, awsOpsModule],
});
