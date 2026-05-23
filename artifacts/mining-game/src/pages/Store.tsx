import { useGetStore, useGetWallet, useBuyItem } from "@workspace/api-client-react";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { ShoppingCart, Gem } from "lucide-react";

export default function Store() {
  const { data: storeItems } = useGetStore();
  const { data: wallet, refetch: refetchWallet } = useGetWallet();
  const buyItem = useBuyItem();
  const { toast } = useToast();

  const handleBuy = (itemId: string, cost: number) => {
    if ((wallet?.gems || 0) < cost) {
       toast({ title: "INSUFFICIENT FUNDS", variant: "destructive" });
       return;
    }
    
    buyItem.mutate({ data: { itemId, quantity: 1 } }, {
      onSuccess: (res) => {
        if(res.success) {
           toast({ title: "PURCHASE SUCCESSFUL", description: res.message, className: "bg-black border-primary text-primary font-mono uppercase" });
           refetchWallet();
        } else {
           toast({ title: "PURCHASE FAILED", description: res.message, variant: "destructive" });
        }
      }
    });
  };

  if (!storeItems) return <div className="p-8 text-primary font-mono text-center animate-pulse">Connecting to Black Market...</div>;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 md:p-8 space-y-8 max-w-6xl mx-auto font-mono overflow-y-auto h-full">
      
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-black text-primary tracking-tighter uppercase drop-shadow-[0_0_8px_rgba(34,197,94,0.5)]">
            Black Market
          </h1>
          <p className="text-muted-foreground text-sm tracking-widest uppercase mt-1">Acquire Upgrades & Assets</p>
        </div>
        
        <div className="bg-black/50 border border-primary/30 p-3 rounded shadow-[0_0_15px_rgba(34,197,94,0.2)] flex items-center">
           <span className="text-muted-foreground uppercase text-xs tracking-widest mr-3">Available Funds:</span>
           <Gem className="w-5 h-5 text-primary mr-1" />
           <span className="text-xl font-black text-primary">{wallet?.gems || 0}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {storeItems.map((item) => (
          <Card key={item.itemId} className="bg-sidebar border-border flex flex-col hover:border-primary/50 transition-colors">
            <CardHeader>
              <CardTitle className="text-white uppercase tracking-widest text-lg">{item.displayName}</CardTitle>
              <CardDescription className="text-muted-foreground uppercase text-xs tracking-widest">{item.category}</CardDescription>
            </CardHeader>
            <CardContent className="flex-1">
              <div className="w-full aspect-video bg-black/50 border border-border rounded mb-4 flex items-center justify-center">
                 <ShoppingCart className="w-12 h-12 text-muted-foreground opacity-50" />
              </div>
              <p className="text-sm text-muted-foreground">{item.description}</p>
            </CardContent>
            <CardFooter>
              <Button 
                className="w-full font-bold uppercase tracking-widest"
                variant={wallet && wallet.gems >= item.gemCost ? "default" : "secondary"}
                onClick={() => handleBuy(item.itemId, item.gemCost)}
                disabled={buyItem.isPending}
              >
                {wallet && wallet.gems >= item.gemCost ? (
                   <>Buy for {item.gemCost} <Gem className="w-4 h-4 ml-2" /></>
                ) : (
                   <>Requires {item.gemCost} GEMS</>
                )}
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>
    </motion.div>
  );
}
