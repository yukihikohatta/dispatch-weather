"use strict";
const $=id=>document.getElementById(id),COLORS={Low:"#267354",Medium:"#d69a14",High:"#bb3552",Unknown:"#778795",Impassable:"#873b8d"};
const MAPS={denver:"14a33c3821fb4f07908667c593086384",reno:"86c531a21c614a7283f6efc3f0088aec",vegas:"086e2405e03344fa9964433e3232dbda"};
const DOT={UT:["Utah","https://www.udottraffic.utah.gov/"],AZ:["Arizona","https://az511.gov/"],NV:["Nevada","https://www.nvroads.com/"],WY:["Wyoming","https://www.wyoroad.info/pls/Browse/WRR.RoutesResults?SelectedRoute=I80"],CO:["Colorado","https://www.cotrip.org/"]};
let routes,route,segments=[],results=[],dotReports=[],alertCheck,view,graphicsLayer,radarLayer,observationLayer;
let observationCache=new Map();
let currentCheckpoint=0,checkedAt=0,runController,dataVersion=0,radarTimer,radarTimes=[],activeTrip,currentRisk="Unknown";
function h(value){const el=document.createElement("span");el.textContent=String(value??"");return el.innerHTML;}
function time(value){return new Date(value).toLocaleString([],{month:"short",day:"numeric",hour:"numeric",minute:"2-digit",timeZoneName:"short"});}
function mph(value){return Number.isFinite(value)?value.toFixed(1).replace(/\.0$/,"")+" mph":"unavailable";}
function risk(wind,gust){
 if(wind>=50||gust>=50)return "High";
 if(wind>30||gust>30)return "Medium";
 return Number.isFinite(wind)&&Number.isFinite(gust)?"Low":"Unknown";
}
function distance(a,b){const rad=Math.PI/180,dy=(b[1]-a[1])*rad,dx=(b[0]-a[0])*rad,s=Math.sin(dy/2)**2+Math.cos(a[1]*rad)*Math.cos(b[1]*rad)*Math.sin(dx/2)**2;return 7917.52*Math.asin(Math.sqrt(Math.min(1,s)));}
function nearest(vertices,miles,p){
 let best={distance:Infinity,mile:0,point:vertices[0]};
 const scale=Math.cos(p[1]*Math.PI/180);
 for(let i=1;i<vertices.length;i++){
  const a=vertices[i-1],b=vertices[i],x=(b[0]-a[0])*scale,y=b[1]-a[1];
  const f=Math.max(0,Math.min(1,((p[0]-a[0])*scale*x+(p[1]-a[1])*y)/(x*x+y*y||1)));
  const point=[a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f],d=distance(point,p);
  if(d<best.distance)best={distance:d,mile:miles[i-1]+f*(miles[i]-miles[i-1]),point};
 }
 return best;
}
function atMile(vertices,miles,target){
 const i=miles.findIndex(m=>m>=target);
 if(i<=0)return vertices[0];
 const f=(target-miles[i-1])/(miles[i]-miles[i-1]||1);
 return vertices[i-1].map((v,n)=>v+(vertices[i][n]-v)*f);
}
function makeSegments(definition){
 const v=definition.coordinates,m=[0];
 for(let i=1;i<v.length;i++)m.push(m[i-1]+distance(v[i-1],v[i]));
 const points=definition.points.map(p=>({...p,...nearest(v,m,[p.lon,p.lat])})).sort((a,b)=>a.mile-b.mile);
 return points.map((p,i)=>{
  const start=i?(p.mile+points[i-1].mile)/2:0,end=i===points.length-1?m.at(-1):(p.mile+points[i+1].mile)/2;
  return {...p,start,end,coordinates:[atMile(v,m,start),...v.filter((_,j)=>m[j]>start&&m[j]<end),atMile(v,m,end)],lat:p.point[1],lon:p.point[0]};
 });
}
async function json(url,signal){
 const response=await fetch(url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(25000)]):AbortSignal.timeout(25000),headers:{Accept:"application/geo+json, application/json"},cache:"no-cache"});
 if(!response.ok)throw new Error("HTTP "+response.status);
 const payload=await response.json();
 if(payload.error)throw new Error(payload.error.message||"Source returned an error");
 return payload;
}
async function pool(items,fn,count=4){
 let next=0;const values=Array(items.length);
 await Promise.all(Array.from({length:Math.min(count,items.length)},async()=>{while(next<items.length){const i=next++;values[i]=await fn(items[i],i);}}));
 return values;
}
function duration(text){
 const m=/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(text);
 return m?(Number(m[1]||0)*86400+Number(m[2]||0)*3600+Number(m[3]||0)*60+Number(m[4]||0))*1000:NaN;
}
function peakGust(start,end,values,multiplier){
 let covered=start,peak=null;
 for(const row of values){
  const [stamp,span]=row.validTime.split("/"),from=Date.parse(stamp),to=from+duration(span);
  if(to<=start||from>=end)continue;
  if(from>covered||!Number.isFinite(row.value))return null;
  peak=Math.max(peak??0,row.value*multiplier);covered=Math.max(covered,to);
 }
 return covered>=end?peak:null;
}
function observationValue(value,kind){
 if(!Number.isFinite(value?.value))return null;
 const unit=value.unitCode?.split(":").at(-1),n=value.value;
 if(kind==="temperature")return unit==="degC"?n*1.8+32:unit==="degF"?n:null;
 const factor={"km_h-1":.621371192,"m_s-1":2.23693629,"mi_h-1":1,"kn":1.15077945,"kt":1.15077945}[unit];
 return Number.isFinite(factor)?n*factor:null;
}
async function observation(stationsUrl,point,signal){
 try{
  if(!stationsUrl)throw new Error("Nearby stations unavailable");
  if(!observationCache.has(stationsUrl))observationCache.set(stationsUrl,json(stationsUrl,signal));
  const stations=(await observationCache.get(stationsUrl)).features||[];
  const nearest=stations.filter(s=>s.geometry?.type==="Point").sort((a,b)=>distance(a.geometry.coordinates,[point.lon,point.lat])-distance(b.geometry.coordinates,[point.lon,point.lat])).slice(0,3);
  let best;
  for(const station of nearest){
   try{
    const url=station.id+"/observations/latest";
    if(!observationCache.has(url))observationCache.set(url,json(url,signal));
    const data=await observationCache.get(url),p=data.properties,stamp=Date.parse(p.timestamp);
    if(!Number.isFinite(stamp)||stamp>Date.now()+300000)continue;
    const wind=observationValue(p.windSpeed,"wind"),gust=observationValue(p.windGust,"wind"),temp=observationValue(p.temperature,"temperature");
    if(wind===null&&temp===null)continue;
    const row={station:station.properties.stationIdentifier||station.id.split("/").at(-1),name:station.properties.name,coordinates:station.geometry.coordinates,stamp,wind,gust,temp,conditions:p.textDescription||"Conditions unavailable",direction:p.windDirection?.value,url};
    if(!best||stamp>best.stamp)best=row;
    if(Date.now()-stamp<=90*60000)return row;
   }catch(error){if(signal.aborted)throw error;}
  }
  return best||{error:"No usable station observation"};
 }catch(error){return {error:error.message};}
}
async function forecast(point,signal){
 let observed=Promise.resolve({error:"Observation lookup unavailable"});
 try{
  const key=[point.lat,point.lon].map(n=>n.toFixed(4)).join(",");
  const p=(await json("https://api.weather.gov/points/"+key,signal)).properties;
  observed=observation(p.observationStations,point,signal);
  if(!p.forecastHourly||!p.forecastGridData)throw new Error("Forecast endpoints unavailable");
  const [hourly,grid]=await Promise.allSettled([json(p.forecastHourly+"?units=us",signal),json(p.forecastGridData,signal)]);
  if(hourly.status!=="fulfilled")throw hourly.reason;
  const props=hourly.value.properties,issued=Date.parse(props.updateTime||props.generatedAt);
  if(!Number.isFinite(issued)||Date.now()-issued>12*3600000)throw new Error("Forecast issuance is stale or unavailable");
  const g=grid.status==="fulfilled"?grid.value.properties:null,validGrid=g&&g.updateTime===props.updateTime?g.windGust:null;
  const factor={"wmoUnit:km_h-1":.621371192,"wmoUnit:m_s-1":2.23693629,"wmoUnit:mi_h-1":1,"wmoUnit:kt":1.15077945}[validGrid?.uom];
  const hours=props.periods.map(row=>{
   const start=Date.parse(row.startTime),end=Date.parse(row.endTime),speeds=String(row.windSpeed).match(/\d+(?:\.\d+)?/g);
   const wind=String(row.windSpeed).toLowerCase()==="calm"?0:/mph/i.test(row.windSpeed)&&speeds?Math.max(...speeds.map(Number)):null;
   return {start,end,wind,gust:Number.isFinite(factor)?peakGust(start,end,validGrid.values,factor):null,temp:row.temperatureUnit==="F"?row.temperature:row.temperature*1.8+32,precip:row.probabilityOfPrecipitation?.value,conditions:row.shortForecast,direction:row.windDirection};
  });
  return {hours,issued,url:p.forecastHourly,zone:p.forecastZone,observation:await observed};
 }catch(error){if(signal.aborted)throw error;return {hours:[],error:error.message,observation:await observed};}
}
function covers(hours,start,end){return hours.length>0&&hours[0].start<=start&&hours.at(-1).end>end&&hours.every((hour,i)=>i===0||hours[i-1].end>=hour.start);}
function contains(polygon,point){
 function ringInside(ring){
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;}
  return inside;
 }
 return polygon.length&&ringInside(polygon[0])&&!polygon.slice(1).some(ringInside);
}
function alertAt(alert,point,start,end){
 const p=alert.properties,begin=Date.parse(p.onset||p.effective),finish=Date.parse(p.ends||p.expires),geom=alert.geometry;
 if(begin>end||finish<=start)return false;
 return geom?.type==="Polygon"?contains(geom.coordinates,point):geom?.type==="MultiPolygon"?geom.coordinates.some(poly=>contains(poly,point)):false;
}
async function alerts(signal){
 const states=route.id==="vegas"?"UT,AZ,NV":route.id==="reno"?"UT,NV":"UT,WY,CO";
 try{const data=await json("https://api.weather.gov/alerts/active?area="+states,signal);return {features:data.features||[],ok:true,unlocated:(data.features||[]).filter(f=>!f.geometry).length};}
 catch(error){if(signal.aborted)throw error;return {features:[],ok:false,error:error.message};}
}
function evaluate(segment,f,trip,now,alerts){
 const eta=trip.departure+segment.mile/trip.speed*3600000,entry=Math.max(now,trip.departure+segment.start/trip.speed*3600000),exit=Math.max(now,trip.departure+segment.end/trip.speed*3600000);
 const forecastTime=Math.max(now,eta),hour=f.hours.find(h=>h.start<=forecastTime&&h.end>forecastTime),hours=f.hours.filter(h=>h.end>entry&&h.start<=exit);
 const peakWind=hours.reduce((peak,h)=>Number.isFinite(h.wind)?Math.max(peak??0,h.wind):peak,null),peakG=hours.reduce((peak,h)=>Number.isFinite(h.gust)?Math.max(peak??0,h.gust):peak,null);
 let level=risk(peakWind,peakG),reasons=[];
 const allWind=covers(hours,entry,exit)&&hours.every(h=>Number.isFinite(h.wind)&&Number.isFinite(h.gust));
 if(!allWind&&level==="Low")level="Unknown";
 if(level==="High")reasons.push("Sustained wind or gust reaches 50 mph during passage.");
 if(level==="Medium")reasons.push("Sustained wind or gust is above 30 and below 50 mph during passage.");
 const hazards=alerts.features.filter(a=>alertAt(a,segment.point,entry,exit) || (!a.geometry && f.zone && a.properties.affectedZones?.includes(f.zone) && Date.parse(a.properties.onset||a.properties.effective)<=exit && Date.parse(a.properties.ends||a.properties.expires)>entry));
 const severe=hazards.find(a=>/^(High Wind|Extreme Wind|Blizzard|Ice Storm|Snow Squall|Tornado|Severe Thunderstorm|Flash Flood|Winter Storm) Warning$/.test(a.properties.event));
 if(severe){level="High";reasons.push(severe.properties.event);}
 else if(hazards.length){if(level==="Low")level="Medium";reasons.push(...hazards.map(a=>a.properties.event));}
 if(hours.some(h=>/snow|freezing|sleet|fog|dust|thunderstorm|heavy rain|hail/i.test(h.conditions)||h.precip>=30)){if(level==="Low")level="Medium";reasons.push("Precipitation or reduced visibility is forecast during passage.");}
 if(trip.equipment==="triples"&&route.id==="denver"){level="Impassable";reasons.unshift("Ordinary triples are prohibited on the Wyoming corridor (W.S. 31-5-1009).");}
 if(!allWind)reasons.push(f.error||"Wind or gust coverage is incomplete during passage.");
 if(!alerts.ok){if(level==="Low")level="Unknown";reasons.push("NWS alert check unavailable.");}
 const previous=f.hours.filter(h=>h.end>now&&h.end<=entry),wasElevated=previous.some(h=>risk(h.wind,h.gust)==="High"||risk(h.wind,h.gust)==="Medium");
 let easing=eta<=now?"Checkpoint ETA has passed. Showing the current forecast hour.":allWind&&peakWind<=30&&peakG<=30?(wasElevated?"Winds are forecast to ease before passage and remain at or below 30 mph through the segment.":"Forecast wind and gusts stay at or below 30 mph throughout the estimated passage."):allWind?"Elevated wind is forecast during the estimated passage.":"Wind easing cannot be confirmed with the available forecast.";
 let quiet;
 for(let i=0;i<f.hours.length-1;i++){const a=f.hours[i],b=f.hours[i+1];if(a.start>=exit&&a.end===b.start&&risk(a.wind,a.gust)==="Low"&&risk(b.wind,b.gust)==="Low"){quiet=a.start;break;}}
 if(quiet&&(peakWind>30||peakG>30))easing+=" Next two lower-wind hours begin "+time(quiet)+".";
 return {...segment,level,reasons,eta,entry,exit,hour,peakWind,peakG,easing,forecast:f,hazards};
}
function checkpointHTML(row,i){
 return '<button class="checkpoint '+(i===currentCheckpoint?"selected":"")+'" data-checkpoint="'+i+'"><strong>'+h(row.name)+'</strong><p>'+row.mile.toFixed(0)+' mi · ETA '+h(time(row.eta))+'</p><span class="risk '+row.level.toLowerCase()+'">'+h(row.level==='Low'?'Below medium threshold':row.level+' impact')+'</span><p>Passage sustained '+h(mph(row.peakWind))+' · Gust '+h(mph(row.peakG))+'</p><p>'+h(row.easing)+'</p><p>'+h(row.reasons.join(" "))+'</p></button>';
}
function updateSummary(){
 currentRisk=["Impassable","High","Medium","Unknown","Low"].find(level=>results.some(r=>r.level===level))||"Unknown";
 const missing=results.filter(row=>!row.forecast.hours.length).length;
 const head=currentRisk==="Impassable"?"Hold · Configuration restriction":currentRisk==="High"?"Hold · High monitored impact":currentRisk==="Medium"?"Medium monitored impact":currentRisk==="Unknown"?"Forecast coverage incomplete":"Below medium wind threshold";
 $("assessment").style.borderColor=COLORS[currentRisk];
 $("assessment").innerHTML="<h1>"+head+"</h1><p>"+(results.length-missing)+"/"+results.length+" checkpoints have an hourly forecast. "+(alertCheck.ok?"NWS alert check completed.":"NWS alert check unavailable.")+"</p><p>DOT coverage is partial. Verify closures, chains and vehicle restrictions before dispatch.</p>";
 $("checkpoints").innerHTML=results.map(checkpointHTML).join("");$("report").disabled=false;
}
function latLngs(points){return points.map(p=>[p[1],p[0]]);}
function paint(){
 graphicsLayer.clearLayers();
 results.forEach((row,index)=>{
  L.polyline(latLngs(row.coordinates),{color:COLORS[row.level],weight:5,opacity:1})
   .bindPopup("<strong>"+h(row.name)+" · "+h(row.level)+"</strong><p>ETA "+h(time(row.eta))+"</p><p>Sustained "+h(mph(row.peakWind))+" · Gust "+h(mph(row.peakG))+"</p><p>"+h(row.easing)+"</p>")
   .on("click",()=>selectCheckpoint(index)).addTo(graphicsLayer);
 });
 paintObservations();
}
function paintObservations(){
 observationLayer.clearLayers();const stations=new Map();
 for(const row of results){const o=row.forecast.observation;if(o?.station){if(!stations.has(o.station))stations.set(o.station,{...o,checkpoints:[]});stations.get(o.station).checkpoints.push(row.name);}}
 const fresh=[...stations.values()].filter(o=>Date.now()-o.stamp<=90*60000).length;
 $("observation-status").textContent=fresh+" recent / "+stations.size+" reporting stations · Route colors show forecast impact at arrival.";
 for(const o of stations.values()){
  const stale=Date.now()-o.stamp>90*60000,level=stale?"Unknown":risk(o.wind,o.gust),temp=Number.isFinite(o.temp)?Math.round(o.temp)+"°F":"—°F";
  const label='<div class="weather-marker" style="border-color:'+COLORS[level]+'"><strong>'+h(temp)+'</strong><span>'+h(mph(o.wind))+'</span>'+(stale?'<small>Old report</small>':'')+'</div>';
  const age=Math.max(0,Math.round((Date.now()-o.stamp)/60000));
  const popup='<div class="observation-popup"><strong>'+h(o.name||o.station)+'</strong><p><b>Latest station observation'+(stale?' · STALE':'')+'</b><br>'+h(o.conditions)+'</p><p>Temperature '+h(temp)+'<br>Wind '+h(mph(o.wind))+(Number.isFinite(o.direction)?' from '+Math.round(o.direction)+'°':'')+'<br>Gust '+h(mph(o.gust))+'</p><p>Observed '+h(time(o.stamp))+' · '+age+' min ago<br>Station '+h(o.station)+'</p><p>Nearby checkpoints: '+h(o.checkpoints.join(', '))+'</p><p>Station conditions may differ on the highway. Missing gusts are not assumed calm.</p></div>';
  L.marker([o.coordinates[1],o.coordinates[0]],{icon:L.divIcon({className:"weather-station",html:label,iconSize:[72,44],iconAnchor:[36,22]}),title:(o.name||o.station)+": "+o.conditions+", "+temp+", wind "+mph(o.wind),zIndexOffset:400}).bindPopup(popup).addTo(observationLayer);
 }
 if($("show-observations").checked&&!view.hasLayer(observationLayer))observationLayer.addTo(view);
}
function chart(row){
 const from=checkedAt,end=Math.max(from+16*3600000,row.eta+4*3600000),hours=row.forecast.hours.filter(h=>h.end>from&&h.start<end);
 if(!hours.length){$("chart").textContent="Hourly wind forecast unavailable at this checkpoint.";return;}
 const w=880,height=184,l=42,r=13,t=17,b=34,max=Math.max(60,Math.ceil(Math.max(...hours.map(h=>Math.max(h.wind||0,h.gust||0)))/10)*10),start=hours[0].start,finish=hours.at(-1).end;
 const x=value=>l+(value-start)/(finish-start)*(w-l-r),y=value=>height-b-value/max*(height-t-b);
 let svg='<svg viewBox="0 0 '+w+' '+height+'" role="img" aria-label="Forecast wind and gusts in mph with 30 and 50 mph risk thresholds"><rect x="'+l+'" y="'+t+'" width="'+(w-l-r)+'" height="'+(height-b-t)+'" fill="#eef6fa"/><rect x="'+l+'" y="'+y(50)+'" width="'+(w-l-r)+'" height="'+(y(30)-y(50))+'" fill="#fff0c8"/><rect x="'+l+'" y="'+t+'" width="'+(w-l-r)+'" height="'+(y(50)-t)+'" fill="#fbe1e6"/>';
 for(const value of [0,30,50,max])svg+='<path d="M'+l+' '+y(value)+'H'+(w-r)+'" stroke="#bbcbd5"/><text x="9" y="'+(y(value)+4)+'" fill="#294a60">'+value+'</text>';
 for(let i=0;i<5;i++){const stamp=start+(finish-start)*i/4;svg+='<text x="'+Math.max(l,Math.min(w-64,x(stamp)-18))+'" y="'+(height-12)+'">'+h(new Date(stamp).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"}))+'</text>';}
 for(const [key,color]of [["wind","#146b93"],["gust","#b32a54"]]){
  let path="",prev;
  for(const hour of hours){if(!Number.isFinite(hour[key])){prev=null;continue;}path+=(prev?.end===hour.start?"L":"M")+x(hour.start)+" "+y(hour[key])+"H"+x(hour.end)+" ";prev=hour;}
  svg+='<path d="'+path+'" fill="none" stroke="'+color+'" stroke-width="2.5"/>';
 }
 if(row.eta>=start&&row.eta<=finish)svg+='<path d="M'+x(row.eta)+' '+t+'V'+(height-b)+'" stroke="#17374f" stroke-dasharray="4 4"/><text x="'+Math.max(205,Math.min(x(row.eta)+4,w-35))+'" y="13">ETA</text>';
 $("chart").innerHTML=svg+'<text x="45" y="12" fill="#146b93">Sustained</text><text x="126" y="12" fill="#b32a54">Gust</text><text x="'+(w-42)+'" y="12">mph</text></svg>';
}
function selectCheckpoint(index){
 if(!results[index])return;
 currentCheckpoint=index;$("checkpoint-name").textContent=results[index].name+" · Wind at arrival";$("arrival-summary").textContent=results[index].easing;
 $("checkpoints").querySelectorAll(".checkpoint").forEach(el=>el.classList.toggle("selected",+el.dataset.checkpoint===index));chart(results[index]);
}
function settings(){
 const departure=Date.parse($("departure").value),speed=Number($("speed").value);
 if(!Number.isFinite(departure)||speed<1||speed>85)throw new Error("Enter a valid departure and average speed from 1 to 85 mph.");
 return {departure,speed,equipment:$("equipment").value};
}
async function dot(signal){
 const states=route.id==="denver"?["UT","WY","CO"]:route.id==="vegas"?["UT","AZ","NV"]:["UT","NV"];
 const reports=states.map(state=>({state,name:DOT[state][0],url:DOT[state][1],status:"Open the official DOT site to check current corridor restrictions.",notices:[]}));
 if(route.id==="denver"){
  const report=reports.find(r=>r.state==="CO");
  try{
   const layers=["roadClosures","restrictions","chainLaws","winterDriving","roadReports"];
   const data=await Promise.allSettled(layers.map(layer=>json("https://api-511x-co.carsprogram.org/events/map-features?eventClassifications="+layer,signal))),notices=new Set();
   for(const result of data)if(result.status==="fulfilled")for(const f of result.value.features||[]){
    const p=f.properties;if(!/\bI[- ]?25\b/i.test(p.route||""))continue;
    const point=p.eventReport?.location?.primaryPoint;if(point?.lat<39.741||point?.lat>41.01)continue;
    const tmp=document.createElement("div");tmp.innerHTML=(p.title||"")+" · "+(p.description||"");notices.add(tmp.textContent);
   }
   report.notices=[...notices];const succeeded=data.filter(d=>d.status==="fulfilled").length;
   report.status=succeeded?succeeded+"/5 COtrip layers returned. Check notice direction, schedule and vehicle applicability.":"COtrip feed unavailable to this browser. Use the official site.";
  }catch(error){if(signal.aborted)throw error;report.status="COtrip unavailable. Use the official site.";}
 }
 return reports;
}
function drawDot(){$("dot").innerHTML=dotReports.map(r=>'<article><h3><a href="'+r.url+'" target="_blank" rel="noopener">'+h(r.name)+' DOT</a></h3><p>'+h(r.status)+'</p>'+(r.notices.length?'<ul>'+r.notices.map(n=>'<li>'+h(n)+'</li>').join("")+'</ul>':"")+'</article>').join("");}
async function recalculate(){
 if(!routes)return;let trip;try{trip=settings();}catch(error){$("updated").textContent=error.message;return;}
 runController?.abort();runController=new AbortController();const signal=runController.signal,version=++dataVersion;
 $("refresh").disabled=$("apply").disabled=true;$("trip").querySelectorAll("input,select").forEach(el=>el.disabled=true);$("report").disabled=true;observationCache=new Map();observationLayer.clearLayers();$("observation-status").textContent="Loading latest station observations…";pauseRadar();radarTimes=[];$("radar-time").disabled=$("radar-play").disabled=true;if(radarLayer)view.removeLayer(radarLayer);
 route=routes.find(r=>r.id===$("route").value)||routes.find(r=>r.id==="denver");segments=makeSegments(route);activeTrip=trip;checkedAt=Date.now();results=[];currentCheckpoint=0;
 $("updated").textContent="Fetching fresh NWS forecasts…";$("assessment").innerHTML="<h1>Checking "+h(route.name)+"</h1><p>Loading wind, gusts and conditions along the highway.</p>";
 $("checkpoints").innerHTML="<p>Loading "+segments.length+" forecast checkpoints…</p>";$("chart").textContent="Loading wind forecast…";graphicsLayer.clearLayers();
 L.polyline(latLngs(route.coordinates),{color:COLORS.Unknown,weight:5}).addTo(graphicsLayer);
 view.fitBounds(L.latLngBounds(latLngs(route.coordinates)),{padding:[30,30],animate:false});
 $("original").href="https://householdgis.maps.arcgis.com/apps/mapviewer/index.html?webmap="+MAPS[route.id];
 try{
  const alertPromise=alerts(signal),dotPromise=dot(signal);let loaded=0;
  const fs=await pool(segments,async point=>{const f=await forecast(point,signal);if(version===dataVersion)$("updated").textContent="Checking forecasts · "+(++loaded)+"/"+segments.length;return f;});
  const [a,d]=await Promise.all([alertPromise,dotPromise]);if(signal.aborted||version!==dataVersion)return;
  alertCheck=a;dotReports=d;results=segments.map((s,i)=>evaluate(s,fs[i],trip,checkedAt,a));paint();updateSummary();drawDot();selectCheckpoint(0);
  $("updated").textContent="Checked "+time(checkedAt)+" · "+(trip.departure<checkedAt-60000?"Departure is in the past. ":"")+"Refresh to check again.";
  const url=new URL(location.href);url.searchParams.set("route",route.id);history.replaceState(null,"",url);
 }catch(error){if(!signal.aborted){$("updated").textContent="Route check failed · "+error.message;$("assessment").innerHTML="<h1>Route check incomplete</h1><p>Refresh to retry. Verify official weather and DOT reports.</p>";}}
 finally{if(version===dataVersion){$("refresh").disabled=$("apply").disabled=false;$("trip").querySelectorAll("input,select").forEach(el=>el.disabled=false);}}
}
function pauseRadar(){clearInterval(radarTimer);radarTimer=null;$("radar-play").textContent="Play";}
function showRadarFrame(){
 const index=Number($("radar-time").value),stamp=radarTimes[index];if(!stamp||!radarLayer)return;
 radarLayer.setParams({TIME:stamp}); if(!view.hasLayer(radarLayer))radarLayer.addTo(view);$("radar-status").textContent=time(stamp)+" · "+(index+1)+"/"+radarTimes.length;
}
async function loadRadar(){
 const version=dataVersion;pauseRadar();$("radar-load").disabled=true;$("radar-status").textContent="Loading NOAA scan times…";
 try{
  const url="https://nowcoast.noaa.gov/geoserver/observations/weather_radar/ows",response=await fetch(url+"?service=WMS&version=1.3.0&request=GetCapabilities");
  if(!response.ok)throw new Error("NOAA scan times returned HTTP "+response.status);
  const doc=new DOMParser().parseFromString(await response.text(),"text/xml"),layer=Array.from(doc.getElementsByTagName("Layer")).find(el=>Array.from(el.children).some(c=>c.localName==="Name"&&c.textContent==="conus_base_reflectivity_mosaic"));
  const dimension=Array.from(layer?.children||[]).find(el=>el.localName==="Dimension"&&el.getAttribute("name")==="time");
  const times=(dimension?.textContent||"").split(",").map(s=>Date.parse(s)).filter(Number.isFinite).sort((a,b)=>a-b);
  if(times.length<2)throw new Error("NOAA scan timestamps unavailable");
  const finish=times.at(-1),begin=finish-5*3600000,start=times.reduce((best,t)=>Math.abs(t-begin)<Math.abs(best-begin)?t:best,times[0]),chosen=[start];
  for(const stamp of times)if(stamp>start&&stamp<finish&&stamp-chosen.at(-1)>=8*60000)chosen.push(stamp);chosen.push(finish);
  if(version!==dataVersion)return;
  radarTimes=chosen.map(t=>new Date(t).toISOString());$("radar-time").max=radarTimes.length-1;$("radar-time").value=0;
  if(!radarLayer){radarLayer=L.tileLayer.wms(url,{layers:"conus_base_reflectivity_mosaic",format:"image/png",transparent:true,version:"1.3.0",TIME:radarTimes[0],opacity:.65,zIndex:200});}
  $("radar-time").disabled=false;$("radar-play").disabled=false;showRadarFrame();
 }catch(error){$("radar-status").textContent="Radar unavailable · "+error.message;}
 finally{$("radar-load").disabled=false;}
}
function printReport(){
 if(!results.length)return;const report=window.open("","_blank");if(!report){$("updated").textContent="Allow the report window to open, then try again.";return;}
 const rows=results.map(row=>'<tr><th>'+h(row.name)+'<br>'+h(time(row.eta))+'</th><td>'+h(row.level)+'<br>'+h(row.reasons.join(" "))+'</td><td>'+h(mph(row.peakWind))+' sustained<br>'+h(mph(row.peakG))+' gust</td><td>'+h(row.easing)+'</td></tr>').join("");
 report.document.write('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>'+h(route.name)+' dispatch report</title><style>body{font:16px/1.5 system-ui;margin:30px;color:#193348}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:10px;vertical-align:top;border:1px solid #cad5dd}tr{break-inside:avoid}h1{font-size:26px}p{white-space:pre-line}@media print{button{display:none}}</style></head><body><h1>Salt Lake City to '+h(route.name)+'</h1><p>'+h(currentRisk)+' monitored impact · '+h(activeTrip.equipment)+'\nChecked '+h(time(checkedAt))+'\nDeparture '+h(time(activeTrip.departure))+' · Planned average '+activeTrip.speed+' mph</p><p>Medium rollover risk above 30 and below 50 mph. High risk at 50 mph and above. Wind and gusts are checked across each segment’s estimated passage. Forecast sample spacing and travel delays affect accuracy.</p><table><thead><tr><th>Checkpoint / ETA</th><th>Impact</th><th>Wind</th><th>Arrival assessment</th></tr></thead><tbody>'+rows+'</tbody></table><h2>DOT notices and coverage</h2>'+dotReports.map(r=>'<h3>'+h(r.name)+'</h3><p>'+h(r.status)+'<br>'+h(r.url)+'</p>'+r.notices.map(n=>'<p>'+h(n)+'</p>').join("")).join("")+'<p>DOT coverage is partial. Verify closures, chains, dimensions and permit applicability. Forecast easing does not establish DOT reopening.</p><button onclick="window.print()">Print / save PDF</button></body></html>');report.document.close();
}
$("departure").value=new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16);
$("route").value=new URL(location.href).searchParams.get("route")||"denver";
$("trip").addEventListener("submit",e=>{e.preventDefault();recalculate();});
$("refresh").addEventListener("click",recalculate);
$("show-observations").addEventListener("change",()=>{if($("show-observations").checked)observationLayer.addTo(view);else view.removeLayer(observationLayer);});
$("trip").addEventListener("input",()=>{if(results.length){$("updated").textContent="Trip inputs changed. Apply trip and recalculate."; $("assessment").innerHTML="<h1>Recalculation required</h1><p>Apply the current trip inputs to update route colors and arrival forecasts.</p>"; $("report").disabled=true; graphicsLayer.eachLayer(layer=>layer.setStyle({color:COLORS.Unknown}));}});

$("checkpoints").addEventListener("click",e=>{const target=e.target.closest("[data-checkpoint]");if(target)selectCheckpoint(Number(target.dataset.checkpoint));});
$("report").addEventListener("click",printReport);
$("show-checkpoints").onclick=()=>{$("checkpoints").hidden=false;$("dot").hidden=true;$("show-checkpoints").classList.add("active");$("show-dot").classList.remove("active");};
$("show-dot").onclick=()=>{$("checkpoints").hidden=true;$("dot").hidden=false;$("show-dot").classList.add("active");$("show-checkpoints").classList.remove("active");};
$("radar-toggle").onclick=()=>{$("radar").hidden=!$("radar").hidden;if($("radar").hidden){pauseRadar();if(radarLayer)view.removeLayer(radarLayer);}$("radar-toggle").textContent=$("radar").hidden?"Show radar":"Hide radar";};
$("radar-load").onclick=loadRadar;$("radar-time").oninput=()=>{pauseRadar();showRadarFrame();};
$("radar-play").onclick=()=>{if(radarTimer){pauseRadar();return;}$("radar-play").textContent="Pause";radarTimer=setInterval(()=>{$("radar-time").value=(Number($("radar-time").value)+1)%radarTimes.length;showRadarFrame();},950);};
document.addEventListener("visibilitychange",()=>{if(document.hidden)pauseRadar();});
(async()=>{
 try{
  view=L.map("map",{center:[40.5,-108],zoom:6,zoomSnap:.25});
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",{
   attribution:"Tiles © Esri · USGS · NOAA",maxZoom:18
  }).addTo(view);
  graphicsLayer=L.layerGroup().addTo(view);
  observationLayer=L.layerGroup().addTo(view);
  new ResizeObserver(()=>view.invalidateSize({pan:false})).observe($("map"));
  routes=await json("./routes.json");
  $("refresh").disabled=$("apply").disabled=false;
  await recalculate();
 }catch(error){$("updated").textContent="Could not load the map · "+error.message;}
})();
