import type { CandidateInbox } from "../services/candidate-inbox.js";
import { saveOpenRouterKey } from "../services/candidate-ranking.js";
import type { KronosService } from "../services/kronos.js";
import type { EntryControls } from "../services/entry-controls.js";
import { randomBytes, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { Express, Request } from "express";
import type { TransactionSigner } from "../utils/transactions.js";

const SIGNING_TIMEOUT = 45_000;
const HEARTBEAT_TIMEOUT = 60_000;
type Pending = {
  id: string; transaction: string; summary: string; expires: number;
  original: VersionedTransaction; resolve: (tx: VersionedTransaction) => void;
  reject: (error: Error) => void; cleanup: () => void;
};

export class BrowserWalletBridge {
  private sessions = new Map<string, number>();
  private owner: string | null = null;
  private account: PublicKey | null = null;
  private lastSeen = 0;
  private pending: Pending | null = null;

  get address(): string | null {
    if (this.account && Date.now() - this.lastSeen > HEARTBEAT_TIMEOUT) this.disconnect();
    return this.account?.toBase58() ?? null;
  }

  private cookie(req: Request): string {
    return (req.headers.cookie || "").split(";").map(v => v.trim())
      .find(v => v.startsWith("jupiter_bridge="))?.slice("jupiter_bridge=".length) || "";
  }

  private disconnect() {
    this.fail("Wallet disconnected or connection expired");
    this.account = null;
    this.owner = null;
  }

  private fail(message: string) {
    const pending = this.pending;
    this.pending = null;
    if (pending) { pending.cleanup(); pending.reject(new Error(message)); }
  }

  cancelApproval() { this.fail("Entry reviews locked; pending transaction cancelled"); }

  signer(summary: string, signal?: AbortSignal): TransactionSigner {
    const address = this.address;
    if (!address) throw new Error("Connect Jupiter Wallet on the local wallet page first");
    return {
      publicKey: new PublicKey(address), signal,
      signTransaction: async (transaction) => {
        signal?.throwIfAborted();
        if (this.address !== address) throw new Error("Wallet changed; request a new transaction");
        if (this.pending) throw new Error("Another transaction is awaiting wallet approval");
        return await new Promise<VersionedTransaction>((resolve, reject) => {
          const abort = () => this.fail("MCP request cancelled; transaction was not submitted");
          const timer = setTimeout(() => this.fail("Wallet approval expired; transaction was not submitted"), SIGNING_TIMEOUT);
          signal?.addEventListener("abort", abort, { once: true });
          this.pending = {
            id: randomBytes(16).toString("hex"),
            transaction: Buffer.from(transaction.serialize()).toString("base64"),
            summary, expires: Date.now() + SIGNING_TIMEOUT, original: transaction,
            resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); },
          };
        });
      },
    };
  }

  mount(app: Express, port: number, entries: EntryControls, kronos: KronosService, candidateInbox: CandidateInbox) {
    const origin = `http://127.0.0.1:${port}`;
    const webRoot = fileURLToPath(new URL("../../web/", import.meta.url));
    app.use("/wallet", (req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      if (req.method === "POST" && (req.headers.origin !== origin || req.headers["x-wallet-bridge"] !== "1")) {
        res.status(403).json({error:"Wallet requests must come from the local connection page"}); return;
      }
      next();
    });
    app.get("/wallet", (req, res) => {
      for (const [token, used] of this.sessions) if (Date.now()-used>600_000) this.sessions.delete(token);
      let token = this.cookie(req);
      if (!this.sessions.has(token)) {
        if (this.sessions.size >= 16) { res.status(429).send("Too many wallet pages; close unused tabs and retry later"); return; }
        token = randomBytes(32).toString("hex");
        this.sessions.set(token, Date.now());
      }
      res.setHeader("Set-Cookie", `jupiter_bridge=${token}; HttpOnly; SameSite=Strict; Path=/wallet`);
      res.sendFile("index.html", {root:webRoot});
    });
    app.get("/wallet/app.js", (_req,res) => res.sendFile("app.js", {root:webRoot}));
    app.get("/wallet/style.css", (_req,res) => res.sendFile("style.css", {root:webRoot}));
    app.use("/wallet", (req,res,next) => {
      const token = this.cookie(req);
      const lastUsed = this.sessions.get(token);
      if (!lastUsed || Date.now()-lastUsed>600_000) { res.status(401).json({error:"Reload the wallet page"}); return; }
      this.sessions.set(token,Date.now());
      next();
    });
    app.get("/wallet/candidates/status", (_req,res) => res.json(candidateInbox.status()));
    app.post("/wallet/candidates/key", async (req,res) => {
      try { res.json(await saveOpenRouterKey(req.body?.key)); }
      catch(error) { res.status(400).json({error:error instanceof Error?error.message:"Could not save the key"}); }
    });
    app.get("/wallet/candidates/latest", async (_req,res) => {
      try {res.json(await candidateInbox.latest());}
      catch {res.status(500).json({error:"Could not read the candidate inbox"});}
    });
    app.get("/wallet/candidates/history/latest", async (_req,res) => {
      try { res.json(JSON.parse(await readFile(new URL(process.env.NODE_ENV==="test"?"../../.runtime/candidate-history-e2e/latest.json":"../../.runtime/candidate-history/latest.json",import.meta.url),"utf8"))); }
      catch(error:any) { res.status(error.code==="ENOENT"?404:500).json({error:"No historical replay report is available"}); }
    });
    app.post("/wallet/candidates/outcome", async (_req,res) => {
      try {res.json(await candidateInbox.checkOutcome());}
      catch(error){res.status(400).json({error:error instanceof Error?error.message:"Outcome check failed"});}
    });
    app.post("/wallet/candidates/scan", async (req,res) => {
      const controller = new AbortController();
      const cancel = () => { if (!res.writableEnded) controller.abort(); };
      res.on("close", cancel);
      try {const result=await candidateInbox.scan(req.body,controller.signal);if(!res.destroyed)res.json(result);}
      catch(error){if(!res.destroyed)res.status(400).json({error:error instanceof Error?error.message:"Scan failed"});}
      finally {res.off("close",cancel);}
    });
    app.get("/wallet/kronos/evaluation/latest", async (_req,res) => {
      try { res.json(await kronos.latestEvaluation()); }
      catch { res.status(500).json({error:"Could not read the saved evaluation"}); }
    });
    app.post("/wallet/kronos/evaluate", async (req,res) => {
      const controller = new AbortController();
      const cancel = () => { if (!res.writableEnded) controller.abort(); };
      res.on("close", cancel);
      try { const result = await kronos.evaluate(req.body, controller.signal); if (!res.destroyed) res.json(result); }
      catch (error) { if (!res.destroyed) res.status(400).json({error:error instanceof Error ? error.message : "Evaluation failed"}); }
      finally { res.off("close", cancel); }
    });
    app.get("/wallet/kronos/status", (_req,res) => res.json(kronos.status()));
    app.post("/wallet/kronos/forecast", async (req,res) => {
      const controller = new AbortController();
      const cancel = () => { if (!res.writableEnded) controller.abort(); };
      res.on("close", cancel);
      try {
        const result = await kronos.forecast(req.body, controller.signal);
        if (!res.destroyed) res.json(result);
      } catch (error) {
        if (!res.destroyed) res.status(400).json({error:error instanceof Error ? error.message : "Forecast failed"});
      } finally { res.off("close", cancel); }
    });
    app.get("/wallet/status", (req,res) => {
      const address = this.address;
      const owns = this.cookie(req) === this.owner;
      if (owns) this.lastSeen = Date.now();
      const p = owns ? this.pending : null;
      res.json({address:owns ? address : null, connected:owns && !!address,
        entry_controls:entries.status(), trading_enabled:!entries.status().locked, trading_blocker:"Entries require a fresh risk preview, enabled reviews, validated atomic protection, and wallet approval. Native triggers execute later without another popup.",
        pending:p ? {id:p.id,transaction:p.transaction,summary:p.summary,expires:p.expires} : null});
    });
    app.post("/wallet/connect", (req,res) => {
      try {
        const token=this.cookie(req);
        if (this.address && this.owner !== token) { res.status(409).json({error:"Disconnect the other wallet page first"}); return; }
        const address = new PublicKey(req.body.address);
        entries.lock();
        this.fail("Wallet account changed");
        this.account=address; this.owner=token; this.lastSeen=Date.now();
        res.json({address:address.toBase58()});
      } catch { res.status(400).json({error:"Invalid Solana public address"}); }
    });
    app.post("/wallet/disconnect", (req,res) => {
      if (this.cookie(req)===this.owner) { entries.lock(); this.disconnect(); }
      res.json({disconnected:true});
    });
    app.get("/wallet/controls", (_req,res) => res.json(entries.status()));
    app.post("/wallet/entry/:action", async (req,res) => {
      if (!this.address || this.cookie(req)!==this.owner) {res.status(403).json({error:"Connect the wallet on this page first"});return;}
      try {
        const action=req.params.action;
        let result;
        if(action==="lock")result=entries.lock();
        else if(action==="unlock")result=entries.unlock();
        else if(action==="preview")result=await entries.preview(req.body);
        else if(action==="review")result=await entries.review(req.body.preview_id,req.body.signal_confirmed);
        else {res.status(404).json({error:"Unknown entry action"});return;}
        res.json(result);
      } catch(error) {res.status(400).json({error:error instanceof Error?error.message:"Entry control failed"});}
    });
    app.post("/wallet/approval", (req,res) => {
      const address=this.address;
      const p=this.pending;
      if (!address || this.cookie(req)!==this.owner || !p || req.body.id!==p.id || Date.now()>p.expires) {
        res.status(409).json({error:"This approval is no longer active"}); return;
      }
      if (req.body.reject === true) { this.fail("User rejected the transaction"); res.json({rejected:true}); return; }
      try {
        if (typeof req.body.signedTransaction!=="string" || req.body.signedTransaction.length>6000) throw new Error();
        const signed=VersionedTransaction.deserialize(Buffer.from(req.body.signedTransaction,"base64"));
        const message=Buffer.from(signed.message.serialize());
        if (!message.equals(Buffer.from(p.original.message.serialize()))) throw new Error();
        const index=signed.message.staticAccountKeys.findIndex(key=>key.toBase58()===address);
        if(index<0 || index>=signed.message.header.numRequiredSignatures) throw new Error();
        const publicKey=createPublicKey({key:Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),new PublicKey(address).toBuffer()]),format:"der",type:"spki"});
        if (!verify(null,message,publicKey,signed.signatures[index])) throw new Error();
        this.pending=null; p.cleanup(); p.resolve(signed);
        res.json({approved:true});
      } catch { this.fail("Wallet returned an invalid or changed transaction"); res.status(400).json({error:"Invalid or changed signed transaction"}); }
    });
  }
}
