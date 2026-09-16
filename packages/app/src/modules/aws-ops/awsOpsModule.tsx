import { EntityCardBlueprint } from '@backstage/plugin-catalog-react/alpha';
import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { AwsOpsCard } from './AwsOpsCard';

export const awsOpsModule = createFrontendModule({
  pluginId: 'catalog',
  extensions: [
    EntityCardBlueprint.make({
      name: 'aws-ops',
      params: {
        filter: 'kind:component',
        loader: () => Promise.resolve(<AwsOpsCard />),
      },
    }),
  ],
});

export default awsOpsModule;
