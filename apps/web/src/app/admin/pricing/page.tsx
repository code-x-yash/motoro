'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { PlatformConfigDto, PricingRuleDto } from '@rr/types';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, LoadingState, Select, Table, Tbody, Td, Th, Thead, Tr } from '@rr/ui';
import { AppShell } from '@/components/app-shell';
import { apiGet, apiPatch, apiPost, errorMessage, fieldErrors } from '@/lib/api';
import { formatINR } from '@/lib/format';

export default function AdminPricingPage() {
  return (
    <AppShell roles={['ADMIN']}>
      <PricingAdmin />
    </AppShell>
  );
}

function PricingAdmin() {
  const [rules, setRules] = useState<PricingRuleDto[]>([]);
  const [config, setConfig] = useState<PlatformConfigDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ code: '', name: '', amount: '0', type: 'FIXED' as 'FIXED' | 'PERCENT' | 'PER_KM' });
  const [configDraft, setConfigDraft] = useState<Record<string, string>>({});

  const load = async () => {
    try {
      const [pricingData, configData] = await Promise.all([
        apiGet<{ items: PricingRuleDto[] }>('/api/admin/pricing'),
        apiGet<{ items: PlatformConfigDto[] }>('/api/admin/config'),
      ]);
      setRules(pricingData.items);
      setConfig(configData.items);
      const draft: Record<string, string> = {};
      for (const item of configData.items) draft[item.key] = typeof item.value === 'object' ? JSON.stringify(item.value) : String(item.value);
      setConfigDraft(draft);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const addRule = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFields({});
    try {
      await apiPost('/api/admin/pricing', {
        code: form.code.trim(),
        name: form.name.trim(),
        amountCents: Math.round(Number(form.amount) * 100),
        type: form.type,
        active: true,
        sort: rules.length,
      });
      setForm({ code: '', name: '', amount: '0', type: 'FIXED' });
      await load();
    } catch (err) {
      setFields(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleRule = async (rule: PricingRuleDto) => {
    setBusy(true);
    try {
      await apiPatch(`/api/admin/pricing/${rule.id}`, { active: !rule.active });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const saveConfig = async (key: string) => {
    setBusy(true);
    try {
      const raw = configDraft[key] ?? '';
      let value: unknown = raw;
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
      if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
      await apiPatch('/api/admin/config', { key, value });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingState label="Loading pricing…" />;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="page-title">Pricing & configuration</h1>
        <p className="page-subtitle">Service fees, surge rules and platform-wide settings.</p>
      </div>

      {error ? <Alert tone="danger" className="mb-4">{error}</Alert> : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Pricing rules</CardTitle>
            <Badge tone="blue">{rules.length} rules</Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            <Table>
              <Thead>
                <Tr>
                  <Th>Code</Th>
                  <Th>Name</Th>
                  <Th>Value</Th>
                  <Th className="text-right">State</Th>
                </Tr>
              </Thead>
              <Tbody>
                {rules.map((rule) => (
                  <Tr key={rule.id}>
                    <Td className="font-mono text-xs">{rule.code}</Td>
                    <Td>{rule.name}</Td>
                    <Td>
                      {rule.type === 'PERCENT'
                        ? `${rule.amountCents}%`
                        : rule.type === 'PER_KM'
                          ? `${formatINR(rule.amountCents)}/km`
                          : formatINR(rule.amountCents)}
                    </Td>
                    <Td className="text-right">
                      <Button size="sm" variant={rule.active ? 'secondary' : 'primary'} loading={busy} onClick={() => void toggleRule(rule)}>
                        {rule.active ? 'Active' : 'Disabled'}
                      </Button>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>

            <form onSubmit={addRule} className="grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-2">
              <Field label="Code" error={fields.code}>
                <Input value={form.code} onChange={(event) => setForm((prev) => ({ ...prev, code: event.target.value }))} placeholder="NIGHT_SURCHARGE" required />
              </Field>
              <Field label="Name" error={fields.name}>
                <Input value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} placeholder="Night surcharge" required />
              </Field>
              <Field label="Value" error={fields.amountCents} hint="Rupees (or percent for PERCENT)">
                <Input type="number" min={0} step={1} value={form.amount} onChange={(event) => setForm((prev) => ({ ...prev, amount: event.target.value }))} required />
              </Field>
              <Field label="Type">
                <Select value={form.type} onChange={(event) => setForm((prev) => ({ ...prev, type: event.target.value as typeof form.type }))}>
                  <option value="FIXED">Fixed (₹)</option>
                  <option value="PERCENT">Percent (%)</option>
                  <option value="PER_KM">Per km (₹)</option>
                </Select>
              </Field>
              <div className="sm:col-span-2">
                <Button type="submit" loading={busy}>
                  Add rule
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Platform config</CardTitle>
            <span className="text-xs text-slate-500">Stored in platform_config and cached in KV.</span>
          </CardHeader>
          <CardContent className="space-y-3">
            {config.map((item) => (
              <div key={item.key} className="grid gap-2 sm:grid-cols-5 sm:items-center">
                <span className="truncate font-mono text-xs text-slate-600 sm:col-span-2">{item.key}</span>
                <Input
                  value={configDraft[item.key] ?? ''}
                  onChange={(event) => setConfigDraft((prev) => ({ ...prev, [item.key]: event.target.value }))}
                  className="sm:col-span-2"
                />
                <Button size="sm" variant="secondary" loading={busy} onClick={() => void saveConfig(item.key)}>
                  Save
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
