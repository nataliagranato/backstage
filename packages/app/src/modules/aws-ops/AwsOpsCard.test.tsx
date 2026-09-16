import { AwsOpsCard } from './AwsOpsCard';
import { EntityProvider } from '@backstage/plugin-catalog-react';
import { TestApiProvider } from '@backstage/test-utils';
import { fetchApiRef } from '@backstage/core-plugin-api';
import { render, screen, waitFor } from '@testing-library/react';

const entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: {
    name: 'minha-api',
    annotations: { 'alura.tech/aws-stack': 'minha-api' },
  },
  spec: { type: 'service', lifecycle: 'production', owner: 'group:tech-preta' },
};

const fetchMock = {
  fetch: jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ stack: 'minha-api', outputs: {} }),
  }),
};

describe('AwsOpsCard', () => {
  it('consulta o status da API ao renderizar', async () => {
    render(
      <TestApiProvider apis={[[fetchApiRef, fetchMock]]}>
        <EntityProvider entity={entity as any}>
          <AwsOpsCard />
        </EntityProvider>
      </TestApiProvider>,
    );
    await waitFor(() =>
      expect(fetchMock.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/aws-ops/status?stack=minha-api'),
      ),
    );
  });

  it('avisa quando a entidade não tem a anotação aws-stack', () => {
    const semAnotacao = { ...entity, metadata: { name: 'x' } };
    render(
      <TestApiProvider apis={[[fetchApiRef, fetchMock]]}>
        <EntityProvider entity={semAnotacao as any}>
          <AwsOpsCard />
        </EntityProvider>
      </TestApiProvider>,
    );
    expect(screen.getByText(/alura.tech\/aws-stack/)).toBeInTheDocument();
  });
});
