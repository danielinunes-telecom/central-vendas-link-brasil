'use client'
import { useEffect, useRef } from 'react'
import { init, use, type EChartsType, type EChartsCoreOption } from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, GraphicComponent, AriaComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

use([BarChart,LineChart,PieChart,GridComponent,TooltipComponent,GraphicComponent,AriaComponent,CanvasRenderer])

export const palette=['#1763f6','#5379de','#20a888','#8394b3','#e0a052','#6b5db7']
export const gridLine={lineStyle:{color:'#e9edf4',type:'dashed'}}
export const labelText={color:'#64748b',fontSize:11,fontFamily:'Inter Variable, sans-serif'}
export const tooltip={backgroundColor:'#132444',borderColor:'#243759',textStyle:{color:'#fff',fontSize:12},padding:10,confine:true}
export type ChartClick = {name:string;dataIndex:number;seriesIndex:number}
export function Chart({option,label,height=230,onClick}:{option:EChartsCoreOption;label:string;height?:number;onClick?:(value:ChartClick)=>void}) {
  const ref=useRef<HTMLDivElement>(null),instance=useRef<EChartsType|null>(null),click=useRef(onClick)
  useEffect(()=>{click.current=onClick},[onClick])
  useEffect(()=>{
    const node=ref.current
    if (!node) return
    const chart=init(node,undefined,{renderer:'canvas'})
    instance.current=chart
    const resize=new ResizeObserver(()=>{if (node.clientWidth>0 && node.clientHeight>0) chart.resize()})
    resize.observe(node)
    chart.on('click',param=>{
      if (param.componentType==='series' && param.seriesIndex!=null) click.current?.({name:param.name,dataIndex:param.dataIndex,seriesIndex:param.seriesIndex})
    })
    return ()=>{resize.disconnect();chart.dispose();instance.current=null}
  },[])
  useEffect(()=>{
    instance.current?.setOption({
      animationDuration:450,animationDurationUpdate:300,color:palette,
      textStyle:{fontFamily:'Inter Variable, sans-serif'},
      ...option,
    },{notMerge:true})
  },[option])
  return <div ref={ref} style={{height,width:'100%',minWidth:0}} role="img" aria-label={label} className="chart-canvas"/>
}

