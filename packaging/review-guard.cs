using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// Trusted Windows resource guardian. Repository evidence is forwarded as bytes, never parsed or executed.
// Job objects constrain resources/lifetime; the companion partial supplies AppContainer isolation.
internal static partial class ReviewGuard {
  const uint KillOnClose=0x2000, ProcessMemory=0x100, JobMemory=0x200, ProcessTime=0x2, ActiveProcess=0x8, Priority=0x20;
  const uint CreateSuspended=0x4, NoWindow=0x08000000, ExtendedStartup=0x80000, BelowNormal=0x4000;
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long ProcessUserTime,JobUserTime; public uint Flags; public UIntPtr MinWorkingSet,MaxWorkingSet; public uint ActiveProcesses; public UIntPtr Affinity; public uint PriorityClass,SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory; }
  [StructLayout(LayoutKind.Sequential)] struct CpuRate { public uint Flags,Rate; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long User,Kernel,PeriodUser,PeriodKernel; public uint Faults,TotalProcesses,ActiveProcesses,TerminatedProcesses; }
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct StartupInfo { public int Size; public string Reserved,Desktop,Title; public uint X,Y,XSize,YSize,XCount,YCount,Fill,Flags; public short Show,ReservedSize; public IntPtr ReservedData,Input,Output,Error; }
  [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo Info; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint Pid,Tid; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimits info,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref CpuRate info,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,ref ExtendedLimits info,uint size,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,ref Accounting info,uint size,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,ref CpuRate info,uint size,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inside);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SecurityAttributes attributes,int size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string executable,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref StartupInfoEx info,out ProcessInfo process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForMultipleObjects(uint count,IntPtr[] handles,bool all,uint timeout);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern uint SetErrorMode(uint mode);
  static void Check(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string Quote(string s) {
    if(s.IndexOf('\0')>=0 || s.IndexOf('"')>=0) throw new ArgumentException("Invalid executable path");
    // Paths are absolute regular files, never directory names ending in a separator.
    return "\""+s+"\"";
  }
  static int Bound(string s,int min,int max) { int n;if(!int.TryParse(s,out n)||n<min||n>max) throw new ArgumentException("Invalid resource bound");return n; }
  static void Close(ref IntPtr handle) { if(handle!=IntPtr.Zero) { CloseHandle(handle);handle=IntPtr.Zero; } }
  static Thread Pump(Stream from,Stream to,bool closeTarget) {
    Thread t=new Thread(delegate() { try { byte[] buffer=new byte[4096];int count;while((count=from.Read(buffer,0,buffer.Length))>0) { to.Write(buffer,0,count);to.Flush(); } } catch(IOException) {} catch(ObjectDisposedException) {} finally { from.Dispose();if(closeTarget)to.Dispose(); } });
    t.IsBackground=true;t.Start();return t;
  }
  static FileStream PipeStream(IntPtr handle,FileAccess access) { return new FileStream(new SafeFileHandle(handle,true),access,4096,false); }
  public static int Main(string[] args) {
    IntPtr job=IntPtr.Zero,parent=IntPtr.Zero,list=IntPtr.Zero,jobValue=IntPtr.Zero,handlesValue=IntPtr.Zero;
    IntPtr appSid=IntPtr.Zero,capValue=IntPtr.Zero,directoryLock=IntPtr.Zero,childEnvironment=IntPtr.Zero;FileStream reportStream=null;
    IntPtr inputRead=IntPtr.Zero,inputWrite=IntPtr.Zero,outputRead=IntPtr.Zero,outputWrite=IntPtr.Zero,errorRead=IntPtr.Zero,errorWrite=IntPtr.Zero;
    ProcessInfo child=new ProcessInfo();bool listReady=false;Thread stdout=null,stderr=null,preparationWatch=null;ManualResetEvent preparationDone=null;
    string phase="arguments";
    try {
      if(args.Length!=16) throw new ArgumentException("Invalid guardian arguments");
      string[] names={"--executable","--worker","--parent","--commit-mib","--cpu-ms","--heap-mib","--wall-ms","--report"};
      for(int i=0;i<names.Length;i++)if(args[i*2]!=names[i])throw new ArgumentException("Invalid guardian option");
      string exe=Path.GetFullPath(args[1]),worker=Path.GetFullPath(args[3]),report=Path.GetFullPath(args[15]);
      if(!Path.IsPathRooted(args[1])||!Path.IsPathRooted(args[3])||!Path.IsPathRooted(args[15])||!File.Exists(exe)||!File.Exists(worker)) throw new ArgumentException("Missing absolute runtime path");
      int parentPid=Bound(args[5],1,int.MaxValue),memory=Bound(args[7],32,256),cpu=Bound(args[9],1,5000),heap=Bound(args[11],16,128),wall=Bound(args[13],1,20000);
      byte[] reportKey=Convert.FromBase64String(Environment.GetEnvironmentVariable("COBBLE_REVIEW_GUARD_KEY")??"");
      if(reportKey.Length!=32)throw new ArgumentException("Missing private report key");
      SetErrorMode(0x1|0x2|0x8000);
      parent=OpenProcess(0x100000,false,parentPid);Check(parent!=IntPtr.Zero);
      preparationDone=new ManualResetEvent(false);
      preparationWatch=new Thread(delegate() {
        uint stopped=WaitForMultipleObjects(2,new IntPtr[]{parent,preparationDone.SafeWaitHandle.DangerousGetHandle()},false,(uint)wall);
        if(stopped==0)Environment.Exit(125);else if(stopped==0x102)Environment.Exit(124);
      });
      preparationWatch.IsBackground=true;preparationWatch.Start();
      phase="container-profile";appSid=ContainerSid();RefuseLoopbackExemption(appSid);
      var package=new System.Security.Principal.SecurityIdentifier(appSid);
      phase="control-folder";report=PrepareControl(report,package,out directoryLock,out reportStream);
      phase="staging";string runtimeDigest;exe=StageRuntime(exe,package,out runtimeDigest);worker=StageWorker(worker,report,package);
      preparationDone.Set();preparationWatch.Join();preparationWatch=null;preparationDone.Dispose();preparationDone=null;
      Check(WaitForSingleObject(parent,0)==0x102);
      phase="job";job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero);
      ExtendedLimits limits=new ExtendedLimits();limits.Basic.Flags=KillOnClose|ProcessMemory|JobMemory|ProcessTime|ActiveProcess|Priority;
      limits.Basic.ProcessUserTime=checked((long)cpu*10000);limits.Basic.ActiveProcesses=1;limits.Basic.PriorityClass=BelowNormal;
      limits.ProcessMemory=new UIntPtr(checked((ulong)memory*1024*1024));limits.JobMemory=limits.ProcessMemory;
      Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))));
      CpuRate rate=new CpuRate();rate.Flags=0x1|0x4;rate.Rate=(uint)Math.Max(1,Math.Min(10000,20000/Environment.ProcessorCount));
      Check(SetInformationJobObject(job,15,ref rate,(uint)Marshal.SizeOf(typeof(CpuRate))));
      SecurityAttributes security=new SecurityAttributes();security.Length=Marshal.SizeOf(typeof(SecurityAttributes));security.Inherit=true;
      Check(CreatePipe(out inputRead,out inputWrite,ref security,4096));Check(SetHandleInformation(inputWrite,1,0));
      Check(CreatePipe(out outputRead,out outputWrite,ref security,4096));Check(SetHandleInformation(outputRead,1,0));
      Check(CreatePipe(out errorRead,out errorWrite,ref security,4096));Check(SetHandleInformation(errorRead,1,0));
      IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,3,0,ref size);list=Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(list,3,0,ref size));listReady=true;
      jobValue=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(jobValue,job);
      Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x2000D),jobValue,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
      handlesValue=Marshal.AllocHGlobal(IntPtr.Size*3);Marshal.WriteIntPtr(handlesValue,0,inputRead);Marshal.WriteIntPtr(handlesValue,IntPtr.Size,outputWrite);Marshal.WriteIntPtr(handlesValue,IntPtr.Size*2,errorWrite);
      Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handlesValue,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero));
      Capabilities caps=new Capabilities();caps.Sid=appSid;caps.List=IntPtr.Zero;caps.Count=0;
      capValue=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Capabilities)));Marshal.StructureToPtr(caps,capValue,false);
      Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20009),capValue,new IntPtr(Marshal.SizeOf(typeof(Capabilities))),IntPtr.Zero,IntPtr.Zero));
      StartupInfoEx start=new StartupInfoEx();start.Info.Size=Marshal.SizeOf(typeof(StartupInfoEx));start.Info.Flags=0x100;start.Info.Input=inputRead;start.Info.Output=outputWrite;start.Info.Error=errorWrite;start.Attributes=list;
      string command=Quote(exe)+" --preserve-symlinks-main --preserve-symlinks --permission "+Quote("--allow-fs-read="+worker)+" --max-old-space-size="+heap+" --max-semi-space-size=8 --v8-pool-size=1 --disallow-code-generation-from-strings "+Quote(worker);
      childEnvironment=CleanEnvironment();
      phase="create-process";Check(CreateProcess(exe,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,CreateSuspended|NoWindow|ExtendedStartup|BelowNormal|0x400,childEnvironment,Path.GetDirectoryName(worker),ref start,out child));
      phase="verify-job";bool inside;Check(IsProcessInJob(child.Process,job,out inside));Check(inside);phase="verify-container";VerifyContainer(child.Process,appSid);
      Close(ref inputRead);Close(ref outputWrite);Close(ref errorWrite);
      FileStream stdinTarget=PipeStream(inputWrite,FileAccess.Write);inputWrite=IntPtr.Zero;
      FileStream stdoutSource=PipeStream(outputRead,FileAccess.Read);outputRead=IntPtr.Zero;
      FileStream stderrSource=PipeStream(errorRead,FileAccess.Read);errorRead=IntPtr.Zero;
      Pump(Console.OpenStandardInput(),stdinTarget,true);
      stdout=Pump(stdoutSource,Console.OpenStandardOutput(),false);stderr=Pump(stderrSource,Console.OpenStandardError(),false);
      Check(ResumeThread(child.Thread)!=0xFFFFFFFF);Close(ref child.Thread);
      string cause="child_exit";
      Stopwatch elapsed=Stopwatch.StartNew();
      while(true) {
        uint remaining=(uint)Math.Max(1,wall-elapsed.ElapsedMilliseconds);
        uint wait=WaitForMultipleObjects(2,new IntPtr[]{parent,child.Process},false,Math.Min(250,remaining));
        if(wait==1) break;
        if(wait==0) { cause="parent_exit";Check(TerminateJobObject(job,125));break; }
        if(wait!=0x102) throw new Win32Exception(Marshal.GetLastWin32Error());
        Accounting sample=new Accounting();Check(QueryInformationJobObject(job,1,ref sample,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero));
        if((sample.User+sample.Kernel)/10000>=cpu) { cause="cpu_limit";Check(TerminateJobObject(job,123));break; }
        if(elapsed.ElapsedMilliseconds>=wall) { cause="wall_timeout";Check(TerminateJobObject(job,124));break; }
      }
      Check(WaitForSingleObject(child.Process,5000)==0);
      uint exit;Check(GetExitCodeProcess(child.Process,out exit));
      Check(stdout.Join(2000));Check(stderr.Join(2000));
      Accounting usage=new Accounting();Check(QueryInformationJobObject(job,1,ref usage,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero));
      Check(QueryInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits)),IntPtr.Zero));
      Check(QueryInformationJobObject(job,15,ref rate,(uint)Marshal.SizeOf(typeof(CpuRate)),IntPtr.Zero));
      // Trusted OS counters are written only after the child has exited. No source text is retained here.
      string json="{\"version\":2,\"inJob\":true,\"inAppContainer\":true,\"capabilityCount\":0,\"runtimeDigest\":\""+runtimeDigest+"\",\"pid\":"+child.Pid+",\"commitLimitBytes\":"+limits.ProcessMemory.ToUInt64()+",\"peakCommitBytes\":"+limits.PeakProcessMemory.ToUInt64()+",\"userCpuMs\":"+(usage.User/10000)+",\"kernelCpuMs\":"+(usage.Kernel/10000)+",\"processLimit\":"+limits.Basic.ActiveProcesses+",\"cpuRate\":"+rate.Rate+",\"cause\":\""+cause+"\",\"exitCode\":"+exit+"}";
      byte[] payload=Encoding.UTF8.GetBytes(json);string mac;
      using(var hmac=new System.Security.Cryptography.HMACSHA256(reportKey))mac=BitConverter.ToString(hmac.ComputeHash(payload)).Replace("-","").ToLowerInvariant();
      string envelope="{\"payload\":\""+Convert.ToBase64String(payload)+"\",\"mac\":\""+mac+"\"}";
      byte[] encoded=Encoding.UTF8.GetBytes(envelope);reportStream.Write(encoded,0,encoded.Length);reportStream.Flush(true);
      return unchecked((int)exit);
    } catch(Exception e) {
      Console.Error.WriteLine("COBBLE_REVIEW_GUARD_UNAVAILABLE: "+phase+":"+(e is Win32Exception ? ((Win32Exception)e).NativeErrorCode.ToString() : e.GetType().Name));return 125;
    } finally {
      // Closing the sole noninherited job handle kills its assigned child even after guardian failure.
      Close(ref job);Close(ref child.Thread);Close(ref child.Process);
      if(preparationDone!=null)preparationDone.Set();if(preparationWatch!=null)preparationWatch.Join();if(preparationDone!=null)preparationDone.Dispose();
      if(runtimeLease!=null)runtimeLease.Dispose();if(reportStream!=null)reportStream.Dispose();Close(ref directoryLock);Close(ref parent);
      if(childEnvironment!=IntPtr.Zero)Marshal.FreeHGlobal(childEnvironment);
      Close(ref inputRead);Close(ref inputWrite);Close(ref outputRead);Close(ref outputWrite);Close(ref errorRead);Close(ref errorWrite);
      if(listReady)DeleteProcThreadAttributeList(list);if(list!=IntPtr.Zero)Marshal.FreeHGlobal(list);
      if(capValue!=IntPtr.Zero)Marshal.FreeHGlobal(capValue);if(appSid!=IntPtr.Zero)FreeSid(appSid);
      if(jobValue!=IntPtr.Zero)Marshal.FreeHGlobal(jobValue);if(handlesValue!=IntPtr.Zero)Marshal.FreeHGlobal(handlesValue);
    }
  }
}
