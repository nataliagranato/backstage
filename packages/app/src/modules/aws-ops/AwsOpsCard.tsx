import { useEntity } from '@backstage/plugin-catalog-react';
import { InfoCard } from '@backstage/core-components';
import { fetchApiRef, useApi } from '@backstage/core-plugin-api';
import Button from '@material-ui/core/Button';
import Typography from '@material-ui/core/Typography';
import { useCallback, useEffect, useState } from 'react';

const ANNOTATION = 'alura.tech/aws-stack';

export const AwsOpsCard = () => {
  const { entity } = useEntity();
  const stackName = entity.metadata.annotations?.[ANNOTATION];
  const { fetch } = useApi(fetchApiRef);
  const [status, setStatus] = useState<string>('consultando…');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const refresh = useCallback(async () => {
    if (!stackName) return;
    try {
      const res = await fetch(
        `/api/aws-ops/status?stack=${encodeURIComponent(stackName)}`,
      );
      const next = res.ok ? 'provisionada' : 'não provisionada';
      setStatus((cur) => (cur.startsWith('erro') ? cur : next));
    } catch {
      setStatus((cur) =>
        cur.startsWith('erro') ? cur : 'erro ao consultar status',
      );
    }
  }, [fetch, stackName]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000); // poll leve; apply em progresso aparece sozinho
    return () => clearInterval(t);
  }, [refresh]);

  if (!stackName) {
    return (
      <InfoCard title="Operações AWS">
        <Typography variant="body2">
          Adicione a anotação <code>{ANNOTATION}: &lt;stack&gt;</code> no
          catalog-info.yaml para habilitar as operações AWS.
        </Typography>
      </InfoCard>
    );
  }

  const call = async (path: string) => {
    setBusy(true);
    setStatus('consultando…'); // limpa erro anterior ao tentar de novo
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stackName }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setStatus(`erro: ${body.error ?? res.status}`);
        return;
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <InfoCard title={`Operações AWS — ${stackName}`}>
      <Typography variant="body1" data-testid="stack-status">
        Status: {status}
      </Typography>
      <Typography variant="body2" color="textSecondary">
        O template HCL é enviado via API/Scaffolder; o card executa rollback e
        consulta status.
      </Typography>
      <Button
        disabled={busy}
        color={confirming ? 'secondary' : 'primary'}
        onClick={() => {
          if (!confirming) {
            setConfirming(true);
            return;
          }
          setConfirming(false);
          call('/api/aws-ops/rollback');
        }}
      >
        {confirming ? `Confirmar rollback de ${stackName}?` : 'Rollback'}
      </Button>
    </InfoCard>
  );
};
