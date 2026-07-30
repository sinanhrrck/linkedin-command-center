import { db } from "../db/index.js";
import { listCampaigns, type CampaignRow } from "./campaigns.js";

export const EXPERIMENT_METRICS = ["acceptance", "reply", "meeting"] as const;
export type ExperimentMetric = (typeof EXPERIMENT_METRICS)[number];

const clean = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

export function createExperiment(input: { name: string; hypothesis?: string; metric: ExperimentMetric; campaignA: number; campaignB: number }) {
  const name = clean(input.name, 100);
  if (!name || !EXPERIMENT_METRICS.includes(input.metric)) throw new Error("Experiment bitte vollständig ausfüllen.");
  const ids = [Number(input.campaignA), Number(input.campaignB)];
  if (!ids.every((id) => Number.isInteger(id) && id > 0) || ids[0] === ids[1]) throw new Error("Wähle zwei unterschiedliche Kampagnen als Varianten.");
  const known = db.prepare("SELECT COUNT(*) AS n FROM campaigns WHERE id IN (?,?)").get(ids[0], ids[1]) as { n: number };
  if (known.n !== 2) throw new Error("Eine ausgewählte Kampagne existiert nicht mehr.");
  const result = db.prepare("INSERT INTO experiments(name,hypothesis,metric) VALUES(?,?,?)").run(name, clean(input.hypothesis, 320) || null, input.metric);
  const id = Number(result.lastInsertRowid);
  const add = db.prepare("INSERT INTO experiment_arms(experiment_id,campaign_id,label) VALUES(?,?,?)");
  add.run(id, ids[0], "A"); add.run(id, ids[1], "B");
  return id;
}

export function setExperimentStatus(id: number, status: "active" | "paused" | "finished") {
  if (!Number.isInteger(id) || id <= 0) return false;
  return db.prepare(
    "UPDATE experiments SET status=?, finished_at=CASE WHEN ?='finished' THEN datetime('now') ELSE NULL END WHERE id=?",
  ).run(status, status, id).changes > 0;
}

const measurement = (campaign: CampaignRow, metric: ExperimentMetric) => {
  if (metric === "acceptance") return { sample: campaign.invited, converted: campaign.accepted };
  if (metric === "meeting") return { sample: campaign.messaged, converted: campaign.meetings };
  return { sample: campaign.messaged, converted: campaign.replied };
};

/** Kein Signifikanz-Theater: unter 8 Beobachtungen je Arm gibt es nur „Daten sammeln“. */
export function listExperiments() {
  const campaigns = new Map(listCampaigns().map((campaign) => [campaign.id, campaign]));
  const experiments = db.prepare("SELECT id,name,hypothesis,metric,status,created_at,finished_at FROM experiments ORDER BY status='active' DESC, created_at DESC").all() as Array<Record<string, unknown>>;
  const arms = db.prepare("SELECT experiment_id,campaign_id,label FROM experiment_arms ORDER BY label").all() as Array<{ experiment_id: number; campaign_id: number; label: string }>;
  return experiments.map((experiment) => {
    const metric = experiment.metric as ExperimentMetric;
    const variants = arms.filter((arm) => arm.experiment_id === experiment.id).map((arm) => {
      const campaign = campaigns.get(arm.campaign_id);
      const result = campaign ? measurement(campaign, metric) : { sample: 0, converted: 0 };
      return { ...arm, campaignName: campaign?.name ?? "Gelöschte Kampagne", ...result, rate: result.sample ? Math.round(result.converted / result.sample * 100) : null };
    });
    const ready = variants.length >= 2 && variants.every((arm) => arm.sample >= 8);
    const sorted = [...variants].sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
    const leader = ready && sorted[0]?.rate !== sorted[1]?.rate ? sorted[0]?.label ?? null : null;
    return { ...experiment, variants, ready, leader };
  });
}
