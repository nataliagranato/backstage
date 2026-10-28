import { AwsOpsCard } from './AwsOpsCard';
import { EntityProvider } from '@backstage/plugin-catalog-react';
import { TestApiProvider } from '@backstage/test-utils';
import { fetchApiRef } from '@backstage/core-plugin-api';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

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

  it('mostra erro quando o rollback falha com 409', async () => {
    render(
      <TestApiProvider apis={[[fetchApiRef, fetchMock]]}>
        <EntityProvider entity={entity as any}>
          <AwsOpsCard />
        </EntityProvider>
      </TestApiProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('stack-status')).toHaveTextContent(
        'provisionada',
      ),
    );
    fetchMock.fetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: 'rollback não executado' }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rollback' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Confirmar rollback de minha-api?',
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('stack-status')).toHaveTextContent(
        'erro: rollback não executado',
      ),
    );
    expect(fetchMock.fetch).toHaveBeenCalledWith(
      '/api/aws-ops/rollback',
      expect.anything(),
    );
  });
});
