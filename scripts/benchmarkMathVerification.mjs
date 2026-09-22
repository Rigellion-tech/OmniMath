import '../tests/helpers/noExternalNetwork.mjs';
import fs from 'node:fs';
import { runBenchmark } from './verification-benchmark/evaluate.mjs';
const report=runBenchmark();
const destination=process.argv[2];
if(destination)fs.writeFileSync(destination,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({overall:report.overall,byCategory:report.byCategory,failures:report.failures,falseContradictions:report.falseContradictions,falseVerified:report.falseVerified,extraction:report.extraction.summary},null,2));
if(report.failures.length||report.falseContradictions.length||report.falseVerified.length)process.exitCode=1;
