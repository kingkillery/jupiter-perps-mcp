import {readFile} from 'node:fs/promises';

// Exploratory post-hoc diagnostic over already-inspected research archives.
// No new model calls, wallet access, live settings, or trades.
const report=JSON.parse(await readFile(new URL('../.runtime/kronos-long-history/latest.json',import.meta.url),'utf8'));
const profile=report.selected_profile;
const grid=[0,.25,.5,.75,1];
const rows=phase=>report.rows.filter(row=>row.phase===phase&&row.profile===profile);
const errors=(items,alpha)=>items.flatMap(row=>row.actual.map((point,i)=>
  Math.abs(row.origin_close+alpha*(row.predicted[i].close-row.origin_close)-point.close)));
const mae=(items,alpha)=>{const values=errors(items,alpha);return values.reduce((a,b)=>a+b,0)/values.length;};
const selection=Object.fromEntries(grid.map(alpha=>[alpha,mae(rows('selection'),alpha)]));
const chosen=grid.reduce((best,alpha)=>selection[alpha]<selection[best]?alpha:best,0);
const holdout=Object.fromEntries(grid.map(alpha=>[alpha,mae(rows('holdout'),alpha)]));
const pairedWins=rows('holdout').filter(row=>mae([row],chosen)<mae([row],0)).length;
console.log(JSON.stringify({warning:'Exploratory only: the shrinkage hypothesis and grid were formed after the original holdout was inspected.',
  profile,grid,selection_mae_usd:selection,selection_chosen_shrink_factor:chosen,
  holdout_mae_usd:holdout,holdout_windows:rows('holdout').length,
  chosen_window_wins_vs_unchanged_price:pairedWins,
  chosen_beats_unchanged_price:holdout[chosen]<holdout[0]},null,2));
